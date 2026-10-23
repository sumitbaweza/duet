// "Compatibility mode": when the partner's browser can't decode the movie (e.g. HEVC on Firefox),
// or the file can't be repackaged but the host's browser can still play it, the host's <video> is
// captured and sent like a live video call (WebRTC media tracks). The partner sees a live picture
// and their play / pause / seek buttons remote-control the host's player.
//
// Handshake on the control channel:
//   host  -> {t:'compat', on:true, streamId, duration, name, size}
//   guest -> {t:'compat-ready'}            (guest now knows which incoming tracks are the movie)
//   host adds the tracks; later {t:'compat', on:false} switches back to normal streaming.

const VIDEO_BITRATE = 4_000_000;
const AUDIO_BITRATE = 160_000;

export function canCapture(video) {
  return typeof video.captureStream === 'function' || typeof video.mozCaptureStream === 'function';
}

export class CompatSender {
  /**
   * @param {import('./peer.js').Peer} peer
   * @param {HTMLVideoElement} video the host's playing <video>
   */
  constructor(peer, video) {
    this.peer = peer;
    this.video = video;
    this.transceivers = new Map(); // kind -> RTCRtpTransceiver
    this.stream = null;
    this.ready = false;
  }

  /** Announce compatibility mode; tracks are attached when the guest says it's ready. */
  start({ duration, name, size }) {
    const v = this.video;
    this.stream = v.captureStream ? v.captureStream() : v.mozCaptureStream();
    this.stream.addEventListener('addtrack', () => this.attachTracks());
    this.peer.sendControl({ t: 'compat', on: true, streamId: this.stream.id, duration, name, size });
  }

  onReady() {
    this.ready = true;
    this.attachTracks();
  }

  attachTracks() {
    if (!this.ready || this.peer.closed) return;
    for (const track of this.stream.getTracks()) {
      const existing = this.transceivers.get(track.kind);
      if (existing) {
        if (existing.sender.track !== track) existing.sender.replaceTrack(track).catch(() => {});
        continue;
      }
      if (track.kind === 'video') track.contentHint = 'motion';
      else track.contentHint = 'music';
      const t = this.peer.pc.addTransceiver(track, {
        direction: 'sendonly',
        streams: [this.stream],
        sendEncodings: [{ maxBitrate: track.kind === 'video' ? VIDEO_BITRATE : AUDIO_BITRATE }],
      });
      this.transceivers.set(track.kind, t);
    }
  }

  stop() {
    for (const t of this.transceivers.values()) {
      try {
        t.stop();
      } catch {}
    }
    this.transceivers.clear();
    if (!this.peer.closed) this.peer.sendControl({ t: 'compat', on: false });
  }
}
