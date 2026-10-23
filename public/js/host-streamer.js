// Host side of the movie pipe: reads the local file, turns it into fragmented MP4 and pushes it to the
// guest over the "video" RTCDataChannel.
//
// Wire format on the video channel (ordered + reliable):
//   string  {t:'meta', name, size, duration, tracks:[{id, type, codec, mime}], adaptive?, variants?, bitrate?}
//   string  {t:'seg', track, gen, size, init?, last?, mime?, bitrate?}   followed by `size` bytes (binary)
//   string  {t:'reset', gen, time}            after a seek / quality switch; guest drops queued older data
//   string  {t:'probe', size}                 followed by `size` junk bytes: measures link speed
// Guest replies on the control channel: {t:'accept', tracks, canOriginal, canAvc}, {t:'need', time},
// {t:'status', time, ahead, full, limit}.
//
// Modes (`mode`):
//   'remux'       Mediabunny rebuilds the file as fragmented MP4 on the fly (remux-source.js). Used for
//                 the partner whenever the file is readable ("adaptive" streamers), and for the host's
//                 own playback of files the browser can't play natively (MKV, AC-3 sound…). In adaptive
//                 mode it also picks a quality: the original, or a live H.264 re-encode (1080p…360p)
//                 that fits the measured link speed — YouTube-style auto quality.
//   'mp4box'      Fallback for MP4/MOV Mediabunny can't read: mp4box.js repackages it per track.
//   'passthrough' Fallback for already-fragmented MP4: original fragments sent as-is (fmp4-index.js).

import { createFile, MP4BoxBuffer } from '/vendor/mp4box/mp4box.all.mjs';
import { indexFragments, fragmentAt, rewriteMoofForMse } from './fmp4-index.js';
import { RemuxSource } from './remux-source.js';

const ISO_BOXES = new Set(['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip', 'pnot']);

const indexCache = new WeakMap(); // File -> fragment index, so re-streaming after a rejoin is instant

const READ_SIZE = 1024 * 1024; // read 1 MB of the file at a time
const SEGMENT_SECONDS = 2; // target fragment length
// How much may wait in the DataChannel's send queue: ~half a second of the link's speed. Enough to
// keep the link busy, yet short, because everything queued before a seek or quality switch has to
// drain before the new position arrives (a fixed 8 MB meant 16 s of "Buffering…" at 4 Mbps).
const QUEUE_SECONDS = 0.5;
const MIN_HIGH_WATER = 256 * 1024;
const MAX_HIGH_WATER = 8 * 1024 * 1024;
const DEFAULT_HIGH_WATER = 1024 * 1024; // until the link has been measured
const MAX_GUEST_AHEAD = 90; // default cap on how far ahead the guest buffers (it may ask for less)

// Auto-quality ladder (H.264 re-encodes). Audio (~160 kbps AAC) comes on top.
export const LADDER = [
  { id: '1080', short: 1080, bitrate: 6_000_000 },
  { id: '720', short: 720, bitrate: 3_000_000 },
  { id: '480', short: 480, bitrate: 1_400_000 },
  { id: '360', short: 360, bitrate: 700_000 },
];
const AUDIO_BPS = 160_000;
const USABLE_SHARE = 0.75; // use at most 75% of the measured link for the movie
const PROBE_MS = 1200;
const REPROBE_EVERY_MS = 25_000;
const AVC_PROBE_MIME = 'video/mp4; codecs="avc1.640028, mp4a.40.2"';

export class HostStreamer {
  /**
   * @param {File} file
   * @param {import('./peer.js').Peer} [peer] omit to only probe() the file
   * @param {{adaptive?: boolean}} [options] adaptive: stream to a partner with auto quality
   */
  constructor(file, peer = null, { adaptive = false } = {}) {
    this.file = file;
    this.peer = peer;
    this.adaptive = adaptive;
    this.channel = peer?.video;
    this.mp4 = createFile();
    this.info = null;
    this.offset = 0;
    this.gen = 0;
    this.queue = []; // {track, buffer, last} produced by mp4box, waiting to be sent
    this.pendingSeek = null;
    this.started = false;
    this.closed = false;
    this.pumping = false;
    this.guestAhead = 0;
    this.guestTime = 0;
    this.guestFull = false;
    this.guestLimit = MAX_GUEST_AHEAD;
    this.wakeResolvers = [];
    this.bytesSent = 0;
    // Auto quality state
    this.quality = 'auto'; // user's choice: 'auto' | 'original' | '1080' | '720' | '480' | '360'
    this.variant = null; // what's streaming now: null = original, or a LADDER rung
    this.link = { bps: peer?.linkBps ?? null, queued: 0, lastDrained: 0, lastBuffered: 0, lastAt: performance.now() };
    this.votes = { up: 0, down: 0 };
    this.slowTicks = 0;
    this.maxShort = Infinity; // lowered when this device can't re-encode fast enough
    this.lastProbeAt = 0;
    this.blockedMs = 0;
    this.onState = null; // (state) => void, for the stats panel / quality menu
    this.onTooSlow = null; // () => void, when even the lowest re-encode can't keep up

    this.mp4.onError = (mod, msg) => console.warn('mp4box', mod, msg);
    this.mp4.onSegment = (id, _user, buffer, nextSample, last) => {
      this.queue.push({ track: id, buffer, last });
      this.mp4.releaseUsedSamples(id, nextSample);
    };
  }

  /** Parse the file header. Resolves with the playable track list or throws if unsupported. */
  async probe() {
    // Streaming to a partner: Mediabunny for everything it can read (enables auto quality).
    if (this.adaptive) {
      try {
        return await this.probeRemux();
      } catch (err) {
        console.warn('Adaptive streaming unavailable for this file, using direct path:', err.message);
        this.remux?.dispose();
        this.remux = null;
      }
    }
    // Only MP4/MOV go through mp4box; anything else (MKV, WebM…) straight to the remux path,
    // instead of letting mp4box read the whole file looking for a moov.
    const head = new Uint8Array(await this.file.slice(0, 12).arrayBuffer());
    const box = String.fromCharCode(...head.subarray(4, 8));
    if (!ISO_BOXES.has(box)) return this.probeRemux();

    let offset = 0;
    let info = null;
    this.mp4.onReady = (i) => (info = i); // fires synchronously inside appendBuffer
    while (!info && offset < this.file.size) {
      const end = Math.min(offset + READ_SIZE, this.file.size);
      const ab = await this.file.slice(offset, end).arrayBuffer();
      const next = this.mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(ab, offset), end >= this.file.size);
      offset = next > offset ? next : end;
    }
    if (!info) return this.probeRemux();
    this.info = info;
    // Sound that isn't AAC (AC-3, DTS, PCM from cameras, MP3…) won't play everywhere: convert it.
    // mp4box lists PCM ('sowt', 'lpcm'…) as a "metadata" track, so with no audio track at all but some
    // other track present, let the converter take a look (it plays video-only files fine too).
    const sound = info.audioTracks[0];
    const otherTracks = info.tracks.some((t) => !info.videoTracks.includes(t));
    if (sound ? !sound.codec.startsWith('mp4a.40') : otherTracks) return this.probeRemux();
    // Fragmented input: the moov has no sample table (it's all in the moofs).
    const fragmented =
      info.isFragmented && this.mp4.moov.traks.every((t) => !t.mdia?.minf?.stbl?.stsz?.sample_count);
    this.mode = fragmented ? 'passthrough' : 'mp4box';
    if (fragmented) return this.probeFragmented(info);
    const tracks = [...info.videoTracks, ...info.audioTracks].map((t) => ({
      id: t.id,
      type: info.videoTracks.includes(t) ? 'video' : 'audio',
      codec: t.codec,
      mime: `${info.videoTracks.includes(t) ? 'video' : 'audio'}/mp4; codecs="${t.codec}"`,
      language: t.language,
      nbSamples: t.nb_samples,
      seconds: (t.samples_duration || t.duration) / t.timescale,
    }));
    if (!tracks.some((t) => t.type === 'video')) throw new Error('No video track found in this file.');
    this.tracks = tracks;
    const duration = info.duration / info.timescale;
    return {
      t: 'meta',
      name: this.file.name,
      size: this.file.size,
      duration,
      bitrate: duration ? (this.file.size * 8) / duration : 0,
      tracks: tracks.map(({ nbSamples, seconds, ...t }) => t),
    };
  }

  async probeFragmented(info) {
    const { ftyp, moov } = this.mp4;
    this.trexSizes = new Map((moov.mvex?.trexs ?? []).map((t) => [t.track_id, t.default_sample_size]));
    if (!indexCache.has(this.file)) {
      indexCache.set(
        this.file,
        await indexFragments(this.file, {
          scanFrom: moov.start + moov.size,
          timescales: new Map(info.tracks.map((t) => [t.id, t.timescale])),
          trexDurations: new Map((moov.mvex?.trexs ?? []).map((t) => [t.track_id, t.default_sample_duration])),
        })
      );
    }
    this.index = indexCache.get(this.file);
    if (!this.index.fragments.length) throw new Error('Could not find any video fragments in this file.');
    this.initRanges = [ftyp, moov].filter(Boolean).map((b) => [b.start, b.start + b.size]);
    const codecs = [...info.videoTracks, ...info.audioTracks].map((t) => t.codec);
    if (!info.videoTracks.length) throw new Error('No video track found in this file.');
    const duration = this.index.duration || info.duration / info.timescale;
    return {
      t: 'meta',
      name: this.file.name,
      size: this.file.size,
      duration,
      bitrate: duration ? (this.file.size * 8) / duration : 0,
      // One SourceBuffer carries audio and video together, exactly as stored in the file.
      tracks: [{ id: 0, type: 'video', codec: codecs.join(', '), mime: `video/mp4; codecs="${codecs.join(', ')}"` }],
    };
  }

  async probeRemux() {
    this.mode = 'remux';
    this.remux = new RemuxSource(this.file);
    const info = (this.remuxInfo = await this.remux.probe());
    this.audioNote = this.remux.audioWasDropped
      ? `This file's sound (${this.remux.audioDescription}) can't be played in browsers, so it will be silent.`
      : null;
    const mime = `video/mp4; codecs="${info.codecs}"`;
    return {
      t: 'meta',
      name: this.file.name,
      size: this.file.size,
      duration: info.duration,
      bitrate: info.bitrate,
      tracks: [{ id: 0, type: 'video', codec: info.codecs, mime }],
      ...(this.adaptive
        ? { adaptive: true, variants: { original: mime, avc: AVC_PROBE_MIME }, width: info.width, height: info.height }
        : {}),
    };
  }

  /**
   * Called once the guest says what its browser can decode. For adaptive streams `caps` says
   * whether it can play the original codec and/or H.264 re-encodes.
   */
  async begin(trackIds, startTime = 0, caps = {}) {
    if (this.mode === 'remux') {
      if (this.adaptive) await this.setupAdaptive(caps);
      this.started = true;
      this.seek(startTime);
      return;
    }
    if (this.mode === 'passthrough') {
      const parts = await Promise.all(this.initRanges.map(([s, e]) => this.file.slice(s, e).arrayBuffer()));
      await this.sendSegment(0, await new Blob(parts).arrayBuffer(), { init: true });
      this.started = true;
      this.seek(startTime);
      return;
    }
    const chosen = this.tracks.filter((t) => trackIds.includes(t.id));
    // mp4box requires the same sample count per segment on every track, so size it from the video
    // frame rate (~2 s of video; audio segments come out ~1–2 s, which is fine).
    const video = chosen.find((t) => t.type === 'video') ?? chosen[0];
    const fps = video && video.seconds > 0 ? video.nbSamples / video.seconds : 30;
    const nbSamples = Math.max(1, Math.round(fps * SEGMENT_SECONDS));
    for (const t of chosen) this.mp4.setSegmentOptions(t.id, null, { nbSamples, rapAlignement: true });
    const inits = this.mp4.initializeSegmentation('per-track');
    for (const init of inits) await this.sendSegment(init.id, init.buffer, { init: true });
    this.mp4.start();
    this.started = true;
    this.seek(startTime);
  }

  // ---------------------------------------------------------------- auto quality

  /** Work out which qualities are possible, measure the link, and pick the starting quality. */
  async setupAdaptive({ canOriginal = true, canAvc = true } = {}) {
    const info = this.remuxInfo;
    const short = Math.min(info.width, info.height);
    this.canOriginal = canOriginal;
    this.rungs = [];
    if (canAvc) {
      for (const rung of LADDER) {
        // Only rungs that are actually smaller/lighter than the original are worth re-encoding.
        if (rung.short > short || rung.bitrate > info.bitrate * 0.8) continue;
        if (await this.remux.canTranscode(rung.short, rung.bitrate)) this.rungs.push(rung);
      }
    }
    if (!this.canOriginal && !this.rungs.length) {
      throw new Error("Partner's browser can't decode this video and this device can't re-encode it.");
    }
    this.sourceBitrate = info.bitrate;
    // Re-encoding a 4K source is heavy (decoding 4K is most of the work). Start at 720p and allow
    // higher only once this device proves it's fast enough (see abrTick).
    this.maxShort = short > 1440 ? 720 : Infinity;
    if (this.link.bps == null) await this.runProbe(PROBE_MS);
    this.variant = this.pickVariant();
    this.meterTimer = setInterval(() => this.meterTick(), 500);
    this.abrTimer = setInterval(() => this.abrTick(), 1000);
    this.emitState();
  }

  /** Bitrate the guest receives for a variant (video + sound). */
  variantBitrate(v) {
    return v ? v.bitrate + AUDIO_BPS : this.sourceBitrate;
  }

  /** Allowed variants, best first: original (if the partner can decode it), then the rungs. */
  options() {
    const rungs = this.rungs.filter((r) => r.short <= this.maxShort);
    return [...(this.canOriginal ? [null] : []), ...rungs];
  }

  pickVariant() {
    const opts = this.options();
    if (!opts.length) return this.rungs[this.rungs.length - 1] ?? null;
    if (this.quality !== 'auto') {
      if (this.quality === 'original' && this.canOriginal) return null;
      const forced = this.rungs.find((r) => r.id === this.quality);
      if (forced) return forced;
    }
    const bps = this.link.bps;
    if (bps == null) return opts.find((v) => v) ?? opts[0]; // unknown: start re-encoded if possible
    const usable = bps * USABLE_SHARE;
    // findIndex, not find: the original quality is `null`, which find() can't tell from "none fits".
    const i = opts.findIndex((v) => this.variantBitrate(v) <= usable);
    return i >= 0 ? opts[i] : opts[opts.length - 1];
  }

  setQuality(q) {
    this.quality = q;
    this.votes = { up: 0, down: 0 };
    const next = this.pickVariant();
    if (next !== this.variant) this.switchTo(next);
    this.emitState();
  }

  /** Continue streaming from the end of what the guest already has, in another quality. */
  switchTo(variant) {
    this.variant = variant;
    this.slowTicks = 0;
    // Queued (not yet appended) data is dropped on the switch, so continue after what's appended.
    const appended = this.guestAppended ?? this.guestAhead;
    const from = appended > 0.5 ? this.guestTime + appended : this.guestTime;
    // The guest already has everything to the end: the new quality applies from the next seek.
    const duration = this.remuxInfo?.duration;
    if (duration && from >= duration - 0.5 && this.remux?.run?.done) return this.emitState();
    this.seek(from);
    this.emitState();
  }

  /** Link speed from how fast the DataChannel drains: exact when it's backed up, a floor otherwise. */
  meterTick() {
    const ch = this.channel;
    if (!ch || ch.readyState !== 'open') return;
    const now = performance.now();
    const L = this.link;
    const buffered = ch.bufferedAmount;
    const drained = L.queued - buffered;
    const dt = (now - L.lastAt) / 1000;
    const d = drained - L.lastDrained;
    if (dt > 0.2 && d > 0) {
      const sample = (d * 8) / dt;
      const full = this.highWater / 2;
      const saturated = buffered > full && L.lastBuffered > full;
      if (saturated) L.bps = L.bps == null ? sample : L.bps * 0.7 + sample * 0.3;
      else if (L.bps == null || sample > L.bps) L.bps = sample;
    }
    L.lastDrained = drained;
    L.lastBuffered = buffered;
    L.lastAt = now;
    if (this.peer) this.peer.linkBps = L.bps;
  }

  /**
   * Fill the DataChannel with junk for ~1 s and time how fast it drains. Only called between
   * segments (never splits one). The guest throws the bytes away.
   */
  async runProbe(ms) {
    const ch = this.channel;
    if (!ch || ch.readyState !== 'open') return;
    this.lastProbeAt = performance.now();
    this.wantProbe = false;
    const chunk = this.peer.maxChunk;
    const junk = new Uint8Array(chunk);
    const t0 = performance.now();
    const drained0 = this.link.queued - ch.bufferedAmount;
    let sent = 0;
    // Keep the link full without queuing much junk (it all drains before the movie continues).
    const cap = Math.max(512 * 1024, this.highWater);
    while (performance.now() - t0 < ms && sent < 24 * 1024 * 1024 && ch.readyState === 'open') {
      if (ch.bufferedAmount > cap) {
        await new Promise((r) => setTimeout(r, 15));
        continue;
      }
      this.send({ t: 'probe', size: chunk });
      ch.send(junk);
      this.link.queued += chunk;
      sent += chunk;
    }
    // Let what's queued drain a little so the measurement covers real transfer, not just queuing.
    const deadline = performance.now() + 400;
    while (ch.bufferedAmount > 0 && performance.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const elapsed = (performance.now() - t0) / 1000;
    const drained = this.link.queued - ch.bufferedAmount - drained0;
    if (elapsed > 0 && drained > 0) {
      const bps = (drained * 8) / elapsed;
      this.link.bps = this.link.bps == null ? bps : Math.max(this.link.bps * 0.5, bps);
      if (this.peer) this.peer.linkBps = this.link.bps;
    }
    this.link.lastDrained = this.link.queued - ch.bufferedAmount;
    this.link.lastAt = performance.now();
  }

  /** Once a second: step quality down quickly when the link is short, up only when clearly sustained. */
  abrTick() {
    if (!this.started || this.closed) return;
    const run = this.remux?.run;
    // The whole rest of the movie is already converted and sent: nothing left to adapt. (Measuring
    // "speed" now would see the clock run with no new output and wrongly step quality down.)
    if (run?.done) return this.emitState();
    // Can this device re-encode fast enough? (media seconds produced per working second)
    if (run && run.variant) {
      const working = (performance.now() - run.startedAt - (run.blockedMs || 0)) / 1000;
      const produced = run.mediaTime - (run.startTime ?? run.mediaTime);
      if (working > 4) {
        const speed = produced / working;
        this.speed = speed;
        if (speed < 1.05 && this.guestAhead < 20) this.slowTicks++;
        else this.slowTicks = Math.max(0, this.slowTicks - 1);
        // Plenty of headroom: allow the next sharper re-encode (the ladder then picks it if the link fits).
        if (speed >= 1.4) this.fastTicks = (this.fastTicks || 0) + 1;
        else this.fastTicks = 0;
        if (this.fastTicks >= 8) {
          this.fastTicks = 0;
          const higher = this.rungs.filter((r) => r.short > run.variant.short && r.short > this.maxShort);
          if (higher.length) this.maxShort = higher[higher.length - 1].short;
        }
        if (this.slowTicks >= 5) {
          const lower = this.rungs.filter((r) => r.short < run.variant.short);
          this.slowTicks = 0;
          if (!lower.length) {
            this.onTooSlow?.();
            return;
          }
          this.maxShort = lower[0].short;
          this.switchTo(this.pickVariant());
          return;
        }
      }
    }
    if (this.quality !== 'auto') return this.emitState();
    const target = this.pickVariant();
    const rank = (v) => this.options().indexOf(v);
    if (target !== this.variant) {
      const lower = rank(target) > rank(this.variant);
      if (lower) {
        this.votes.up = 0;
        // Short on bandwidth: act fast, faster still if the guest is running low.
        if (++this.votes.down >= (this.guestAhead < 12 ? 2 : 4)) this.switchTo(target);
      } else {
        this.votes.down = 0;
        if (++this.votes.up >= 5 && this.guestAhead >= 8) this.switchTo(target);
      }
    } else {
      this.votes = { up: 0, down: 0 };
    }
    // Periodically check whether a better quality would now fit.
    const better = this.options()[0];
    if (this.variant !== better && this.guestAhead >= 10 && performance.now() - this.lastProbeAt > REPROBE_EVERY_MS) {
      this.wantProbe = true;
    }
    this.emitState();
  }

  emitState() {
    this.onState?.({
      quality: this.quality,
      current: this.variant ? `${this.variant.id}p` : 'Original',
      linkBps: this.link.bps,
      movieBps: this.sourceBitrate ?? null,
      streamBps: this.adaptive && this.mode === 'remux' ? this.variantBitrate(this.variant) : null,
      available: this.adaptive && this.rungs ? [...(this.canOriginal ? ['original'] : []), ...this.rungs.map((r) => r.id)] : [],
      speed: this.speed ?? null,
    });
  }

  // ---------------------------------------------------------------- streaming

  /** Jump the stream to `time` seconds (guest scrubbed somewhere it has no data for). */
  seek(time) {
    this.pendingSeek = Math.max(0, time);
    this.gen++;
    this.queue = [];
    this.wake();
    this.pump();
  }

  /** Guest buffer report: decides whether we keep reading the file or rest. */
  updateGuestStatus({ time, ahead, appended, full, limit }) {
    this.guestTime = time ?? this.guestTime;
    this.guestAhead = ahead ?? 0; // includes data still queued on the guest's side
    this.guestAppended = appended ?? this.guestAhead; // already inside the guest's player
    this.guestFull = !!full;
    this.guestLimit = Math.min(MAX_GUEST_AHEAD, limit || MAX_GUEST_AHEAD);
    if (this.guestAhead < this.guestLimit && !this.guestFull) this.wake();
  }

  get guestHasEnough() {
    return this.guestFull || this.guestAhead >= this.guestLimit;
  }

  close() {
    this.closed = true;
    clearInterval(this.meterTimer);
    clearInterval(this.abrTimer);
    this.mp4.stop();
    this.remux?.dispose();
    this.wake();
  }

  wake() {
    const resolvers = this.wakeResolvers;
    this.wakeResolvers = [];
    resolvers.forEach((r) => r());
  }

  sleep(ms) {
    return new Promise((resolve) => {
      this.wakeResolvers.push(resolve);
      if (ms) setTimeout(resolve, ms);
    });
  }

  async pump() {
    if (this.mode === 'remux') return this.pumpRemux();
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.closed && this.started && this.channel.readyState === 'open') {
        if (this.pendingSeek != null) {
          const target = this.pendingSeek;
          this.pendingSeek = null;
          this.queue = [];
          if (this.mode === 'passthrough') {
            const frags = this.index.fragments;
            this.fragIndex = fragmentAt(frags, target);
            this.offset = frags[this.fragIndex].offset;
            this.send({ t: 'reset', gen: this.gen, time: frags[this.fragIndex].time });
            continue;
          }
          const { offset, time } = this.mp4.seek(target, true);
          this.offset = Number.isFinite(offset) ? offset : 0;
          this.send({ t: 'reset', gen: this.gen, time });
          continue;
        }
        if (this.queue.length) {
          await this.drainQueue();
          continue;
        }
        if (this.offset >= this.file.size || this.guestHasEnough) {
          await this.sleep(this.guestFull ? 1000 : 0);
          continue;
        }
        if (this.mode === 'passthrough') {
          await this.sendFragmentPiece();
          continue;
        }
        const gen = this.gen;
        const start = this.offset;
        const end = Math.min(start + READ_SIZE, this.file.size);
        const ab = await this.file.slice(start, end).arrayBuffer();
        if (gen !== this.gen || this.closed) continue; // a seek happened while reading
        const next = this.mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(ab, start), end >= this.file.size);
        this.offset = next > start ? next : end;
      }
    } catch (err) {
      console.error('streamer stopped', err);
    } finally {
      this.pumping = false;
    }
  }

  /**
   * Remux mode: one Mediabunny run per seek position / quality switch, from there to the end.
   * A new seek cancels the running conversion and starts another one. Pauses while the guest has
   * plenty buffered (or its buffer is full), which in turn pauses the conversion.
   */
  async pumpRemux() {
    if (this.pumping) {
      this.remux.cancel(); // the loop below picks up the new pendingSeek
      return;
    }
    this.pumping = true;
    try {
      while (!this.closed && this.started && this.channel.readyState === 'open' && this.pendingSeek != null) {
        const target = this.pendingSeek;
        this.pendingSeek = null;
        const gen = this.gen;
        const variant = this.adaptive ? this.variant : null;
        this.send({ t: 'reset', gen, time: target });
        const live = () => gen === this.gen && !this.closed;
        await this.remux.start(
          target,
          async (bytes, { init, mime }) => {
            const run = this.remux.run;
            const t0 = performance.now();
            while (!init && live() && (this.guestHasEnough || this.wantProbe)) {
              if (this.wantProbe) await this.runProbe(PROBE_MS);
              else await this.sleep(this.guestFull ? 1000 : 0);
            }
            if (live()) {
              const extra = init ? { init: true, mime: `video/mp4; codecs="${mime}"`, bitrate: this.variantBitrate(variant) } : {};
              await this.sendSegment(0, bytes, extra);
            }
            if (run) run.blockedMs = (run.blockedMs || 0) + (performance.now() - t0);
          },
          variant
        );
        // Reached the end of the movie: tell the guest so it can end the stream cleanly.
        if (live() && this.pendingSeek == null) this.send({ t: 'seg', track: 0, gen, size: 0, last: true });
      }
    } catch (err) {
      console.error('remux streamer stopped', err);
    } finally {
      this.pumping = false;
    }
  }

  /** Passthrough: send the next ≤1 MB of the current original fragment (the guest's MSE parser
   *  accepts a fragment split across appends; after a seek it is reset with SourceBuffer.abort()). */
  async sendFragmentPiece() {
    const frags = this.index.fragments;
    const frag = frags[this.fragIndex];
    if (!frag) {
      this.offset = this.file.size;
      return;
    }
    const gen = this.gen;
    const start = Math.max(this.offset, frag.offset);
    // The moof goes on its own, rewritten if it uses absolute file offsets (not allowed in MSE);
    // then its mdat follows in ≤1 MB pieces, byte-for-byte from the file.
    const end = start === frag.offset ? frag.offset + frag.moofSize : Math.min(start + READ_SIZE, frag.end);
    let bytes = await this.file.slice(start, end).arrayBuffer();
    if (gen !== this.gen || this.closed) return; // a seek happened while reading
    if (start === frag.offset) bytes = rewriteMoofForMse(new Uint8Array(bytes), frag.offset, this.trexSizes);
    const fragDone = end >= frag.end;
    const last = fragDone && this.fragIndex === frags.length - 1;
    await this.sendSegment(0, bytes, last ? { last: true } : {});
    if (gen !== this.gen) return;
    if (fragDone) {
      this.fragIndex++;
      this.offset = frags[this.fragIndex]?.offset ?? this.file.size;
    } else {
      this.offset = end;
    }
  }

  async drainQueue() {
    const gen = this.gen;
    while (this.queue.length && gen === this.gen && !this.closed) {
      const { track, buffer, last } = this.queue.shift();
      await this.sendSegment(track, buffer, last ? { last: true } : {});
    }
  }

  send(msg) {
    if (this.channel.readyState === 'open') this.channel.send(JSON.stringify(msg));
  }

  async sendSegment(track, buffer, extra) {
    const bytes = new Uint8Array(buffer);
    const chunk = this.peer.maxChunk;
    const gen = this.gen;
    this.send({ t: 'seg', track, gen, size: bytes.byteLength, ...extra });
    for (let o = 0; o < bytes.byteLength; o += chunk) {
      if (this.channel.bufferedAmount > this.highWater) await this.waitForDrain();
      // Aborting mid-segment is safe: the guest discards a partial segment on the next header.
      // And it must abort once a seek/quality switch superseded it: the new stream's reset and
      // headers may already be on the wire, and leftover bytes after them would corrupt it.
      if (this.closed || this.channel.readyState !== 'open' || gen !== this.gen) return;
      const piece = bytes.slice(o, o + chunk);
      this.channel.send(piece);
      this.bytesSent += piece.byteLength;
      this.link.queued += piece.byteLength;
    }
  }

  get highWater() {
    const bps = this.link.bps;
    if (!bps) return DEFAULT_HIGH_WATER;
    return Math.min(MAX_HIGH_WATER, Math.max(MIN_HIGH_WATER, (bps / 8) * QUEUE_SECONDS));
  }

  waitForDrain() {
    this.channel.bufferedAmountLowThreshold = Math.floor(this.highWater / 4);
    return new Promise((resolve) => {
      const done = () => {
        this.channel.removeEventListener('bufferedamountlow', done);
        this.channel.removeEventListener('close', done);
        resolve();
      };
      this.channel.addEventListener('bufferedamountlow', done);
      this.channel.addEventListener('close', done);
    });
  }
}
