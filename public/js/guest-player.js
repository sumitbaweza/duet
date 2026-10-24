// Guest side of the movie pipe: reassembles fMP4 segments from the "video" DataChannel and
// feeds them into Media Source Extensions so the <video> element plays them like a normal stream.
// Uses ManagedMediaSource where available (required on iPhone Safari 17.1+).
//
// Memory: browsers only let a page keep ~150 MB of video in an MSE buffer (less on phones), which a
// 4K stream fills in under 30 s. So how far ahead / behind we buffer is sized in megabytes from the
// stream's bitrate, not in fixed seconds, and shrinks further if the browser ever says "full".

const MS = window.ManagedMediaSource || window.MediaSource;
const STATUS_EVERY_MS = 1000;
const MB = 1024 * 1024;
// Received-but-not-yet-appended data. Above this we tell the sender to stop *now*: the converter can
// produce a light movie dozens of times faster than real time, and a queue that grows unchecked
// eats RAM and overflows the browser's video memory (which then discards video at the playhead).
const QUEUE_MAX = 6 * MB;
// Largest hole in the buffer we hop over when the playhead is stuck in front of it (seconds).
const MAX_GAP = 3;
const MOBILE = matchMedia('(pointer: coarse)').matches || (navigator.deviceMemory ?? 8) <= 4;
const DEFAULT_BUDGET = (MOBILE ? 60 : 120) * MB; // total bytes we aim to hold in the buffer
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function mseSupported() {
  return !!MS;
}

export class GuestPlayer extends EventTarget {
  /**
   * @param {HTMLVideoElement} video
   * @param {import('./peer.js').Peer} peer
   */
  constructor(video, peer) {
    super();
    this.video = video;
    this.peer = peer;
    this.meta = null;
    this.mediaSource = null;
    this.buffers = new Map(); // trackId -> {track, sb, mime, queue: [ops], ended}
    this.gen = 0;
    this.incoming = null; // segment currently being reassembled
    this.full = false; // the browser's video memory said "quota exceeded"
    this.queuedBytes = 0; // received, waiting to be appended
    this.backlogged = false; // last reported to the sender that the queue is too long
    this.bytesReceived = 0;
    this.closed = false;
    this.budget = DEFAULT_BUDGET;
    this.setBitrate(8_000_000);

    this.onVideoMessage = (e) => this.handleMessage(e.data);
    peer.video.addEventListener('message', this.onVideoMessage);
    this.onSeeking = () => this.ensureDataAt(this.video.currentTime);
    video.addEventListener('seeking', this.onSeeking);
    this.statusTimer = setInterval(() => {
      this.skipGap();
      this.checkHoles();
      this.reportStatus();
    }, STATUS_EVERY_MS);
  }

  /** Re-derive how many seconds to keep ahead / behind from the stream's bitrate and our budget. */
  setBitrate(bps) {
    if (!bps) return;
    this.bitrate = bps;
    const bytesPerSec = bps / 8;
    this.aheadLimit = clamp((this.budget * 0.8) / bytesPerSec, 12, 90);
    this.keepBehind = clamp((this.budget * 0.2) / bytesPerSec, 3, 20);
  }

  handleMessage(data) {
    if (typeof data === 'string') {
      const msg = JSON.parse(data);
      if (msg.t === 'meta') this.handleMeta(msg);
      else if (msg.t === 'seg' || msg.t === 'probe') {
        this.incoming = { ...msg, parts: [], received: 0 };
        if (!msg.size) this.finishIncoming();
      } else if (msg.t === 'reset') {
        this.gen = msg.gen;
        // Drop stale media, but never init segments (they may still be waiting for 'sourceopen').
        // Then reset the MSE parser, which may be halfway through a fragment from before the jump.
        for (const b of this.buffers.values()) {
          b.queue = [{ abort: true }, ...b.queue.filter((op) => op.remove || op.init)];
          b.ended = false;
        }
        this.recountQueue();
        this.pumpAll();
      }
      return;
    }
    const seg = this.incoming;
    if (!seg) return;
    if (seg.received + data.byteLength > seg.size) {
      // More bytes than announced: the stream is out of step. Drop this segment; the next header
      // realigns us (and checkHoles() asks again for anything this loses).
      this.incoming = null;
      return;
    }
    if (seg.t !== 'probe') seg.parts.push(new Uint8Array(data)); // speed-test bytes are thrown away
    seg.received += data.byteLength;
    this.bytesReceived += data.byteLength;
    if (seg.received >= seg.size) this.finishIncoming();
  }

  finishIncoming() {
    const seg = this.incoming;
    this.incoming = null;
    if (seg.t === 'probe') return;
    const out = new Uint8Array(seg.size);
    let o = 0;
    for (const p of seg.parts) {
      out.set(p, o);
      o += p.byteLength;
    }
    const buf = this.buffers.get(seg.track);
    if (!buf) return;
    // Init segments are always needed; media from a superseded seek generation is not.
    if (!seg.init && seg.gen < this.gen) return;
    buf.queue.push({ data: out, init: !!seg.init, last: !!seg.last, mime: seg.mime, bitrate: seg.bitrate });
    this.queuedBytes += out.byteLength;
    this.checkBacklog();
    this.pumpAll();
  }

  recountQueue() {
    let n = 0;
    for (const b of this.buffers.values()) for (const op of b.queue) n += op.data?.byteLength || 0;
    this.queuedBytes = n;
    this.checkBacklog();
  }

  /** Tell the sender right away when the queue crosses the limit (and when it has drained again). */
  checkBacklog() {
    if (!this.backlogged && this.queuedBytes > QUEUE_MAX) {
      this.backlogged = true;
      this.reportStatus();
    } else if (this.backlogged && this.queuedBytes < QUEUE_MAX / 2) {
      this.backlogged = false;
      this.reportStatus();
    }
  }

  /** Remove the next queued op from a buffer's queue, keeping the byte count right. */
  dequeue(b) {
    const op = b.queue.shift();
    if (op?.data) {
      this.queuedBytes = Math.max(0, this.queuedBytes - op.data.byteLength);
      this.checkBacklog();
    }
    return op;
  }

  handleMeta(meta) {
    // Announce the new movie first, whether or not this browser turns out to be able to decode it.
    this.dispatchEvent(new CustomEvent('movie', { detail: { name: meta.name, size: meta.size, title: meta.title } }));
    this.teardownMedia();
    this.meta = meta;
    this.gen = 0; // a new file means a new HostStreamer counting from 0
    this.budget = DEFAULT_BUDGET;
    this.setBitrate(meta.bitrate);

    let chosen;
    let caps = {};
    if (meta.adaptive) {
      // One muxed track whose codec can change mid-stream (original ↔ H.264 re-encode).
      caps = {
        canOriginal: MS.isTypeSupported(meta.variants.original),
        canAvc: MS.isTypeSupported(meta.variants.avc),
      };
      if (!caps.canOriginal && !caps.canAvc) return this.rejectCodec(meta);
      chosen = [{ ...meta.tracks[0], mime: null }]; // SourceBuffer created from the first init's codec
    } else {
      const video = meta.tracks.find((t) => t.type === 'video' && MS.isTypeSupported(t.mime));
      const audio = meta.tracks.find((t) => t.type === 'audio' && MS.isTypeSupported(t.mime));
      if (!video) return this.rejectCodec(meta);
      if (!audio && meta.tracks.some((t) => t.type === 'audio')) {
        const codecs = meta.tracks.filter((t) => t.type === 'audio').map((t) => t.codec).join(', ');
        this.dispatchEvent(
          new CustomEvent('warning', { detail: `Audio codec (${codecs}) not supported here — playing without sound.` })
        );
      }
      chosen = [video, audio].filter(Boolean);
    }
    for (const t of chosen) this.buffers.set(t.id, { track: t, sb: null, mime: null, queue: [], ended: false });

    const ms = (this.mediaSource = new MS());
    if (window.ManagedMediaSource && ms instanceof window.ManagedMediaSource) {
      this.video.disableRemotePlayback = true;
    }
    this.objectUrl = URL.createObjectURL(ms);
    this.video.src = this.objectUrl;
    ms.addEventListener(
      'sourceopen',
      () => {
        if (ms !== this.mediaSource) return;
        ms.duration = meta.duration;
        this.pumpAll();
      },
      { once: true }
    );
    this.peer.sendControl({ t: 'accept', tracks: chosen.map((t) => t.id), ...caps });
    this.dispatchEvent(new CustomEvent('meta', { detail: meta }));
  }

  /** Can't decode anything offered: the host answers with compatibility mode (live video). */
  rejectCodec(meta) {
    const codecs = meta.tracks.filter((t) => t.type === 'video').map((t) => t.codec).join(', ');
    this.meta = null;
    this.peer.sendControl({ t: 'reject', code: 'codec', reason: `Partner's browser can't decode ${codecs}` });
    this.dispatchEvent(new CustomEvent('unsupported', { detail: codecs }));
  }

  /** Create the SourceBuffer on first use, or switch its codec when a different stream starts. */
  prepareSourceBuffer(b, mime) {
    const ms = this.mediaSource;
    if (!ms || ms.readyState === 'closed') return false;
    if (!b.sb) {
      if (ms.readyState !== 'open' || !mime) return false;
      b.sb = ms.addSourceBuffer(mime);
      b.mime = mime;
      b.sb.mode = 'segments';
      b.sb.addEventListener('updateend', () => this.pump(b));
      b.sb.addEventListener('error', () => {
        console.error('SourceBuffer error', b.track, this.video.error?.message);
        this.fail(`Playback error (${b.track.type}): ${this.video.error?.message || 'could not decode stream'}`);
      });
      return true;
    }
    if (mime && mime !== b.mime && typeof b.sb.changeType === 'function') {
      b.sb.changeType(mime);
      b.mime = mime;
    }
    return true;
  }

  pumpAll() {
    for (const b of this.buffers.values()) this.pump(b);
  }

  pump(b) {
    if (this.closed || !this.mediaSource || this.mediaSource.readyState === 'closed') return;
    if (!b.sb) {
      while (b.queue[0]?.abort) b.queue.shift(); // no parser to reset yet
      // Per-track streams know their codec up front; adaptive ones learn it from the first init.
      const head = b.queue[0];
      const mime = b.track.mime || (head?.init ? head.mime : null);
      if (!this.prepareSourceBuffer(b, mime)) return;
    }
    const op = b.queue[0];
    if (b.sb.updating) return;
    this.evictWatched(b);
    if (b.sb.updating) return;
    if (!op) {
      this.maybeEndOfStream();
      return;
    }
    try {
      if (op.abort) {
        b.queue.shift();
        // Not updating here, so this only resets the segment parser. After endOfStream() the
        // source is 'ended' and the parser already finished cleanly, so there's nothing to reset.
        if (this.mediaSource.readyState === 'open') b.sb.abort();
        return this.pump(b);
      }
      if (op.data && !op.data.byteLength) {
        // Empty end-of-movie marker (remux mode).
        this.dequeue(b);
        if (op.last) b.ended = true;
        return this.pump(b);
      }
      if (op.remove) {
        b.queue.shift();
        b.sb.remove(op.remove[0], op.remove[1]);
        return;
      }
      if (op.init) {
        if (op.mime) this.prepareSourceBuffer(b, op.mime);
        if (op.bitrate) this.setBitrate(op.bitrate);
      }
      b.sb.appendBuffer(op.data);
      this.dequeue(b);
      if (op.last) b.ended = true;
      this.full = false;
    } catch (err) {
      if (err.name === 'QuotaExceededError') {
        // The browser's memory limit is lower than we assumed: shrink our budget, free watched
        // video, tell the host to pause, and retry shortly.
        this.full = true;
        this.budget = Math.max(20 * MB, this.budget * 0.75);
        this.setBitrate(this.bitrate);
        this.reportStatus();
        const t = this.video.currentTime;
        if (t - 2 > 0) b.queue.unshift({ remove: [0, t - 2] });
        setTimeout(() => this.pump(b), 1000);
      } else {
        console.error('appendBuffer failed', err);
        this.dequeue(b);
      }
    }
  }

  evictWatched(b) {
    let ranges;
    try {
      ranges = b.sb.buffered;
    } catch {
      return;
    }
    if (!ranges.length) return;
    const t = this.video.currentTime;
    const cutoff = t - this.keepBehind;
    if (ranges.start(0) < cutoff - 2) {
      try {
        b.sb.remove(0, cutoff);
      } catch {}
      return;
    }
    // Also drop anything far ahead that's not contiguous with what's playing (left over from a jump).
    const last = ranges.length - 1;
    if (ranges.start(last) > t + this.aheadLimit + 10) {
      try {
        b.sb.remove(ranges.start(last), Infinity);
      } catch {}
    }
  }

  maybeEndOfStream() {
    const ms = this.mediaSource;
    if (!ms || ms.readyState !== 'open') return;
    for (const b of this.buffers.values()) {
      if (!b.ended || b.queue.length || b.sb?.updating) return;
    }
    try {
      ms.endOfStream();
    } catch {}
  }

  /** Seconds of contiguous media buffered after `time` (minimum across audio and video). */
  bufferedAhead(time = this.video.currentTime) {
    if (!this.buffers.size) return 0;
    let ahead = Infinity;
    for (const b of this.buffers.values()) {
      let r = null;
      try {
        r = b.sb?.buffered; // throws once the MediaSource has errored or closed
      } catch {}
      let a = 0;
      if (r) {
        for (let i = 0; i < r.length; i++) {
          if (time >= r.start(i) - 0.3 && time <= r.end(i)) a = r.end(i) - time;
        }
      }
      ahead = Math.min(ahead, a);
    }
    return ahead;
  }

  /**
   * Hop over a small hole right in front of the playhead. Holes appear when the browser frees
   * memory and takes the frames under the playhead with it, or a stream restarts at a later
   * keyframe; the <video> never plays across one by itself, so without this it waits forever.
   * It's an ordinary seek, so the sync engine moves the partner along with us.
   */
  skipGap() {
    const v = this.video;
    let r;
    try {
      r = v.buffered;
    } catch {
      return;
    }
    const t = v.currentTime;
    const inRange = [...Array(r.length).keys()].some((i) => t >= r.start(i) && t < r.end(i) - 0.05);
    if (v.seeking || inRange || !this.meta) {
      this.stuckAt = null;
      return;
    }
    // Only once it's been stuck on the same spot for a full tick (not mid-seek or just starting).
    if (this.stuckAt !== t) {
      this.stuckAt = t;
      return;
    }
    for (let i = 0; i < r.length; i++) {
      const gap = r.start(i) - t;
      if (gap > 0 && gap <= MAX_GAP && r.end(i) - r.start(i) > 0.5) {
        this.stuckAt = null;
        v.currentTime = r.start(i) + 0.05;
        return;
      }
    }
  }

  /**
   * A hole where playback is heading (data lost in transit, or freed by the browser) that the
   * sender has already moved past never fills by itself. Spot it — the hole stays put while media
   * after it keeps arriving — and ask the sender to stream again from the hole.
   */
  checkHoles() {
    const v = this.video;
    let r;
    try {
      r = v.buffered;
    } catch {
      return;
    }
    if (!this.meta || v.seeking) return;
    const t = v.currentTime;
    let holeAt = t;
    for (let i = 0; i < r.length; i++) if (t >= r.start(i) - 0.3 && t < r.end(i)) holeAt = r.end(i);
    let laterEnd = 0;
    for (let i = 0; i < r.length; i++) if (r.start(i) > holeAt + 0.1) laterEnd = Math.max(laterEnd, r.end(i));
    if (!laterEnd || holeAt - t > this.aheadLimit * 0.8) {
      this.hole = null;
      return;
    }
    if (this.hole?.at !== holeAt) {
      this.hole = { at: holeAt, laterEnd, asked: false };
      return;
    }
    if (!this.hole.asked && laterEnd > this.hole.laterEnd + 0.5) {
      this.hole.asked = true;
      for (const b of this.buffers.values()) b.ended = false;
      this.peer.sendControl({ t: 'need', time: holeAt });
    }
  }

  /** True if playback could proceed at `time` (or the movie is fully loaded to the end). */
  hasDataAt(time, need = 0.5) {
    const ahead = this.bufferedAhead(time);
    const end = this.meta ? this.meta.duration : Infinity;
    return ahead >= need || time + ahead >= end - 0.5;
  }

  ensureDataAt(time) {
    if (!this.meta || this.hasDataAt(time, 0.1)) return;
    for (const b of this.buffers.values()) b.ended = false;
    this.peer.sendControl({ t: 'need', time });
  }

  reportStatus() {
    if (!this.meta) return;
    const appended = this.bufferedAhead();
    // Count queued-but-not-appended data too, or the sender keeps going while we're swamped.
    const queuedSeconds = this.bitrate ? (this.queuedBytes * 8) / this.bitrate : 0;
    this.peer.sendControl({
      t: 'status',
      time: this.video.currentTime,
      ahead: appended + queuedSeconds,
      appended,
      full: this.full || this.queuedBytes > QUEUE_MAX,
      limit: Math.round(this.aheadLimit),
    });
  }

  fail(message) {
    this.dispatchEvent(new CustomEvent('error', { detail: message }));
  }

  teardownMedia() {
    this.buffers.clear();
    this.queuedBytes = 0;
    this.backlogged = false;
    this.incoming = null;
    this.mediaSource = null;
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.statusTimer);
    this.peer.video.removeEventListener('message', this.onVideoMessage);
    this.video.removeEventListener('seeking', this.onSeeking);
    this.teardownMedia();
    this.video.removeAttribute('src');
    this.video.load();
  }
}
