// Host side of the movie pipe: reads the local file, remuxes it into fragmented MP4 with mp4box.js,
// and pushes the fragments to the guest over the "video" RTCDataChannel.
//
// Wire format on the video channel (ordered + reliable):
//   string  {t:'meta', name, size, duration, tracks:[{id, type, codec, mime, language}]}
//   string  {t:'seg', track, gen, size, init?, last?}   followed by `size` bytes in binary messages
//   string  {t:'reset', gen, time}                      after a seek; guest drops queued older-gen data
// Guest replies on the control channel: {t:'accept', tracks:[ids]}, {t:'need', time}, {t:'status', ...}
//
// Files that are *already* fragmented MP4 (many downloads and screen recordings) take a "passthrough"
// path instead: their original fragments are sent as-is on a single muxed track (id 0), using an
// index of fragment start times for seeking, because mp4box can't seek in them.
//
// Everything else (MKV, WebM, MPEG-TS, or MP4/MOV whose sound isn't AAC, e.g. AC-3/DTS/PCM) takes the
// "remux" path: Mediabunny rebuilds it as fragmented MP4 on the fly, copying the video and
// converting the sound to AAC (see remux-source.js). It's also a single muxed track (id 0).
//
// So `mode` is one of: 'mp4box' | 'passthrough' | 'remux'.

import { createFile, MP4BoxBuffer } from '/vendor/mp4box/mp4box.all.mjs';
import { indexFragments, fragmentAt, rewriteMoofForMse } from './fmp4-index.js';
import { RemuxSource } from './remux-source.js';

const ISO_BOXES = new Set(['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip', 'pnot']);

const indexCache = new WeakMap(); // File -> fragment index, so re-streaming after a rejoin is instant

const READ_SIZE = 1024 * 1024; // read 1 MB of the file at a time
const SEGMENT_SECONDS = 2; // target fragment length
const HIGH_WATER = 8 * 1024 * 1024; // pause sending when this much is queued in the DataChannel
const LOW_WATER = 2 * 1024 * 1024;
const MAX_GUEST_AHEAD = 90; // stop reading when guest already has this many seconds buffered

export class HostStreamer {
  /**
   * @param {File} file
   * @param {import('./peer.js').Peer} [peer] omit to only probe() the file
   */
  constructor(file, peer = null) {
    this.file = file;
    this.peer = peer;
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
    this.guestFull = false;
    this.wakeResolvers = [];
    this.bytesSent = 0;

    if (this.channel) this.channel.bufferedAmountLowThreshold = LOW_WATER;
    this.mp4.onError = (mod, msg) => console.warn('mp4box', mod, msg);
    this.mp4.onSegment = (id, _user, buffer, nextSample, last) => {
      this.queue.push({ track: id, buffer, last });
      this.mp4.releaseUsedSamples(id, nextSample);
    };
  }

  /** Parse the file header. Resolves with the playable track list or throws if unsupported. */
  async probe() {
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
    return {
      t: 'meta',
      name: this.file.name,
      size: this.file.size,
      duration: info.duration / info.timescale,
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
    return {
      t: 'meta',
      name: this.file.name,
      size: this.file.size,
      duration: this.index.duration || info.duration / info.timescale,
      // One SourceBuffer carries audio and video together, exactly as stored in the file.
      tracks: [{ id: 0, type: 'video', codec: codecs.join(', '), mime: `video/mp4; codecs="${codecs.join(', ')}"` }],
    };
  }

  async probeRemux() {
    this.mode = 'remux';
    this.remux = new RemuxSource(this.file);
    const info = await this.remux.probe();
    this.audioNote = this.remux.audioWasDropped
      ? `This file's sound (${this.remux.audioDescription}) can't be played in browsers, so it will be silent.`
      : null;
    return {
      t: 'meta',
      name: this.file.name,
      size: this.file.size,
      duration: info.duration,
      tracks: [{ id: 0, type: 'video', codec: info.codecs, mime: `video/mp4; codecs="${info.codecs}"` }],
    };
  }

  /** Called once the guest says which tracks its browser can decode. */
  async begin(trackIds, startTime = 0) {
    if (this.mode === 'remux') {
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

  /** Jump the stream to `time` seconds (guest scrubbed somewhere it has no data for). */
  seek(time) {
    this.pendingSeek = Math.max(0, time);
    this.gen++;
    this.queue = [];
    this.wake();
    this.pump();
  }

  /** Guest buffer report: decides whether we keep reading the file or rest. */
  updateGuestStatus({ ahead, full }) {
    this.guestAhead = ahead ?? 0;
    this.guestFull = !!full;
    if (this.guestAhead < MAX_GUEST_AHEAD && !this.guestFull) this.wake();
  }

  close() {
    this.closed = true;
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
        if (this.offset >= this.file.size || this.guestFull || this.guestAhead >= MAX_GUEST_AHEAD) {
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
   * Remux mode: one Mediabunny run per seek position, from the keyframe at/before it to the end.
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
        this.send({ t: 'reset', gen, time: target });
        const live = () => gen === this.gen && !this.closed;
        await this.remux.start(target, async (bytes, { init }) => {
          while (!init && live() && (this.guestFull || this.guestAhead >= MAX_GUEST_AHEAD)) {
            await this.sleep(this.guestFull ? 1000 : 0);
          }
          if (live()) await this.sendSegment(0, bytes, init ? { init: true } : {});
        });
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
    this.send({ t: 'seg', track, gen: this.gen, size: bytes.byteLength, ...extra });
    for (let o = 0; o < bytes.byteLength; o += chunk) {
      if (this.channel.bufferedAmount > HIGH_WATER) await this.waitForDrain();
      // Aborting mid-segment is safe: the guest discards a partial segment on the next header.
      if (this.closed || this.channel.readyState !== 'open') return;
      this.channel.send(bytes.slice(o, o + chunk));
      this.bytesSent += Math.min(chunk, bytes.byteLength - o);
    }
  }

  waitForDrain() {
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
