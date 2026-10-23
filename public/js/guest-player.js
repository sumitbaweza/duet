// Guest side of the movie pipe: reassembles fMP4 segments from the "video" DataChannel and
// feeds them into Media Source Extensions so the <video> element plays them like a normal stream.
// Uses ManagedMediaSource where available (required on iPhone Safari 17.1+).

const MS = window.ManagedMediaSource || window.MediaSource;
const KEEP_BEHIND = 20; // seconds of already-watched video kept in RAM (for small rewinds)
const STATUS_EVERY_MS = 1000;

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
    this.buffers = new Map(); // trackId -> {sb, queue: [{data, gen, last}|{remove:[a,b]}], ended}
    this.gen = 0;
    this.incoming = null; // segment currently being reassembled
    this.full = false;
    this.bytesReceived = 0;
    this.closed = false;

    this.onVideoMessage = (e) => this.handleMessage(e.data);
    peer.video.addEventListener('message', this.onVideoMessage);
    this.onSeeking = () => this.ensureDataAt(this.video.currentTime);
    video.addEventListener('seeking', this.onSeeking);
    this.statusTimer = setInterval(() => this.reportStatus(), STATUS_EVERY_MS);
  }

  handleMessage(data) {
    if (typeof data === 'string') {
      const msg = JSON.parse(data);
      if (msg.t === 'meta') this.handleMeta(msg);
      else if (msg.t === 'seg') {
        this.incoming = { ...msg, parts: [], received: 0 };
        if (msg.size === 0) this.finishIncoming();
      } else if (msg.t === 'reset') {
        this.gen = msg.gen;
        // Drop stale media, but never init segments (they may still be waiting for 'sourceopen').
        // Then reset the MSE parser, which may be halfway through a fragment from before the jump.
        for (const b of this.buffers.values()) {
          b.queue = [{ abort: true }, ...b.queue.filter((op) => op.remove || op.init)];
          b.ended = false;
        }
        this.pumpAll();
      }
      return;
    }
    const seg = this.incoming;
    if (!seg) return;
    seg.parts.push(new Uint8Array(data));
    seg.received += data.byteLength;
    this.bytesReceived += data.byteLength;
    if (seg.received >= seg.size) this.finishIncoming();
  }

  finishIncoming() {
    const seg = this.incoming;
    this.incoming = null;
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
    buf.queue.push({ data: out, init: !!seg.init, last: !!seg.last });
    this.pumpAll();
  }

  handleMeta(meta) {
    this.teardownMedia();
    this.meta = meta;
    this.gen = 0; // a new file means a new HostStreamer counting from 0
    const video = meta.tracks.find((t) => t.type === 'video' && MS.isTypeSupported(t.mime));
    const audio = meta.tracks.find((t) => t.type === 'audio' && MS.isTypeSupported(t.mime));
    if (!video) {
      // The host switches to compatibility mode (live video) when it gets this.
      const codecs = meta.tracks.filter((t) => t.type === 'video').map((t) => t.codec).join(', ');
      this.meta = null;
      this.peer.sendControl({ t: 'reject', code: 'codec', reason: `Partner's browser can't decode ${codecs}` });
      this.dispatchEvent(new CustomEvent('unsupported', { detail: codecs }));
      return;
    }
    if (!audio && meta.tracks.some((t) => t.type === 'audio')) {
      const codecs = meta.tracks.filter((t) => t.type === 'audio').map((t) => t.codec).join(', ');
      this.dispatchEvent(
        new CustomEvent('warning', { detail: `Audio codec (${codecs}) not supported here — playing without sound.` })
      );
    }
    const chosen = [video, audio].filter(Boolean);
    for (const t of chosen) this.buffers.set(t.id, { track: t, sb: null, queue: [], ended: false });

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
        for (const b of this.buffers.values()) {
          b.sb = ms.addSourceBuffer(b.track.mime);
          b.sb.mode = 'segments';
          b.sb.addEventListener('updateend', () => this.pump(b));
          b.sb.addEventListener('error', () => {
            console.error('SourceBuffer error', b.track, this.video.error?.message);
            this.fail(`Playback error (${b.track.type}): ${this.video.error?.message || 'could not decode stream'}`);
          });
        }
        this.pumpAll();
      },
      { once: true }
    );
    this.peer.sendControl({ t: 'accept', tracks: chosen.map((t) => t.id) });
    this.dispatchEvent(new CustomEvent('meta', { detail: meta }));
  }

  pumpAll() {
    for (const b of this.buffers.values()) this.pump(b);
  }

  pump(b) {
    if (!b.sb || b.sb.updating || this.closed || this.mediaSource?.readyState === 'closed') return;
    this.evictWatched(b);
    if (b.sb.updating) return;
    const op = b.queue[0];
    if (!op) {
      this.maybeEndOfStream();
      return;
    }
    try {
      if (op.abort) {
        b.queue.shift();
        // Not updating here, so this only resets the segment parser. After endOfStream() the
        // source is 'ended' and the parser already finished cleanly, so there's nothing to reset.
        if (this.mediaSource?.readyState === 'open') b.sb.abort();
        return this.pump(b);
      }
      if (op.data && !op.data.byteLength) {
        // Empty end-of-movie marker (remux mode).
        b.queue.shift();
        if (op.last) b.ended = true;
        return this.pump(b);
      }
      if (op.remove) {
        b.queue.shift();
        b.sb.remove(op.remove[0], op.remove[1]);
        return;
      }
      b.sb.appendBuffer(op.data);
      b.queue.shift();
      if (op.last) b.ended = true;
      this.full = false;
    } catch (err) {
      if (err.name === 'QuotaExceededError') {
        // Phone RAM budget hit: tell host to stop sending, free watched video, retry shortly.
        this.full = true;
        this.reportStatus();
        const t = this.video.currentTime;
        if (t - 3 > 0) b.queue.unshift({ remove: [0, t - 3] });
        setTimeout(() => this.pump(b), 1000);
      } else {
        console.error('appendBuffer failed', err);
        b.queue.shift();
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
    const cutoff = this.video.currentTime - KEEP_BEHIND;
    if (ranges.start(0) < cutoff - 5) {
      try {
        b.sb.remove(0, cutoff);
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
    this.peer.sendControl({
      t: 'status',
      time: this.video.currentTime,
      ahead: this.bufferedAhead(),
      full: this.full,
    });
  }

  fail(message) {
    this.dispatchEvent(new CustomEvent('error', { detail: message }));
  }

  teardownMedia() {
    this.buffers.clear();
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
