// Optional face camera over the same peer connection, shown as picture-in-picture bubbles.
// Kept small (≈320×240, ≤300 kbps) so it never starves the movie stream on a slow link.
// Turning it off swaps in a null track (no renegotiation, camera light goes off) and tells the
// partner over the control channel so their bubble disappears immediately.

const CONSTRAINTS = {
  audio: false,
  video: {
    facingMode: 'user',
    width: { ideal: 320 },
    height: { ideal: 240 },
    frameRate: { ideal: 20, max: 24 },
  },
};
const SEND_ENCODING = { maxBitrate: 300_000, maxFramerate: 20 };

export class Camera extends EventTarget {
  /**
   * @param {{selfVideo: HTMLVideoElement, partnerVideo: HTMLVideoElement}} els
   */
  constructor({ selfVideo, partnerVideo }) {
    super();
    this.selfVideo = selfVideo;
    this.partnerVideo = partnerVideo;
    this.stream = null;
    this.track = null;
    this.peer = null;
    this.transceiver = null;
    this.partnerOn = false;
    this.partnerHasTrack = false;
  }

  get on() {
    return this.track?.readyState === 'live';
  }

  get partnerVisible() {
    return this.partnerOn && this.partnerHasTrack;
  }

  /** Attach to a (new) peer connection; re-sends the camera if it was already on. */
  attach(peer) {
    this.peer = peer;
    this.transceiver = null;
    this.partnerOn = false;
    this.partnerHasTrack = false;
    this.partnerVideo.srcObject = null;
    peer.addEventListener('track', (e) => {
      if (e.detail.track.kind !== 'video') return;
      if (e.detail.stream && e.detail.stream.id === peer.compatStreamId) return; // the movie, not a face
      this.partnerVideo.srcObject = e.detail.stream || new MediaStream([e.detail.track]);
      this.partnerVideo.play().catch(() => {});
      this.partnerHasTrack = true;
      this.emit();
    });
    peer.addEventListener('open', () => this.announce());
    if (this.on) this.send();
    this.emit();
  }

  async toggle() {
    if (this.on) this.stop();
    else await this.start();
    return this.on;
  }

  async start() {
    const stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
    this.stream = stream;
    this.track = stream.getVideoTracks()[0];
    // Camera unplugged or permission revoked mid-call.
    this.track.addEventListener('ended', () => this.stop());
    this.selfVideo.srcObject = stream;
    this.selfVideo.play().catch(() => {});
    this.send();
    this.announce();
    this.emit();
  }

  stop() {
    this.track?.stop();
    this.track = null;
    this.stream = null;
    this.selfVideo.srcObject = null;
    this.transceiver?.sender.replaceTrack(null).catch(() => {});
    this.announce();
    this.emit();
  }

  send() {
    if (!this.peer || this.peer.closed || !this.track) return;
    if (this.transceiver) {
      this.transceiver.sender.replaceTrack(this.track).catch((err) => console.warn('replaceTrack', err));
    } else {
      this.transceiver = this.peer.pc.addTransceiver(this.track, {
        direction: 'sendrecv',
        streams: [this.stream],
        sendEncodings: [SEND_ENCODING],
      });
    }
  }

  announce() {
    this.peer?.sendControl({ t: 'cam', on: this.on });
  }

  /** Partner's {t:'cam'} control message. */
  setPartner(on) {
    this.partnerOn = !!on;
    this.emit();
  }

  emit() {
    this.dispatchEvent(new CustomEvent('change', { detail: { self: this.on, partner: this.partnerVisible } }));
  }
}
