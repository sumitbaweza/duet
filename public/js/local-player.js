// Host playback for files the browser can't play by itself (MKV, WebM, AC-3/DTS sound…):
// the host's <video> is fed by exactly the same HostStreamer → GuestPlayer pipeline the partner
// gets, joined by an in-memory channel instead of a WebRTC DataChannel. So the host hears the
// converted sound and seeking works the same way on both sides.

import { HostStreamer } from './host-streamer.js';
import { GuestPlayer } from './guest-player.js';

/** Mimics the bits of RTCDataChannel that HostStreamer and GuestPlayer use. */
class LoopbackChannel extends EventTarget {
  constructor() {
    super();
    this.readyState = 'open';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.binaryType = 'arraybuffer';
  }

  send(data) {
    if (this.readyState !== 'open') return;
    const payload =
      typeof data === 'string' || data instanceof ArrayBuffer
        ? data
        : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    // Deliver asynchronously (like a real channel) but in order.
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: payload })));
  }

  close() {
    this.readyState = 'closed';
  }
}

export class LocalPlayer extends EventTarget {
  /**
   * @param {File} file
   * @param {HTMLVideoElement} video
   */
  constructor(file, video) {
    super();
    this.video = video;
    const channel = (this.channel = new LoopbackChannel());
    const peer = {
      video: channel,
      maxChunk: 4 * 1024 * 1024,
      sendControl: (msg) => this.onControl(msg),
    };
    this.streamer = new HostStreamer(file, peer);
    this.player = new GuestPlayer(video, peer);
    for (const ev of ['error', 'warning']) {
      this.player.addEventListener(ev, (e) => this.dispatchEvent(new CustomEvent(ev, { detail: e.detail })));
    }
  }

  async start() {
    const meta = await this.streamer.probe();
    this.channel.send(JSON.stringify(meta));
    return meta;
  }

  onControl(msg) {
    if (msg.t === 'accept') this.streamer.begin(msg.tracks, this.video.currentTime || 0);
    else if (msg.t === 'need') this.streamer.seek(msg.time);
    else if (msg.t === 'status') this.streamer.updateGuestStatus(msg);
    else if (msg.t === 'reject') this.dispatchEvent(new CustomEvent('error', { detail: msg.reason }));
  }

  get meta() {
    return this.player.meta;
  }

  bufferedAhead() {
    return this.player.bufferedAhead();
  }

  close() {
    this.channel.close();
    this.streamer.close();
    this.player.close();
  }
}
