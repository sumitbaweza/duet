// Voice chat over the same peer connection (Opus over SRTP, browser echo cancellation),
// plus "ducking": the movie gets quieter while your partner is talking.

const DUCK_TO = 0.35; // movie volume multiplier while partner speaks
const SPEAK_THRESHOLD = 0.04; // RMS level that counts as speech
const RELEASE_MS = 700;

export class Voice extends EventTarget {
  /**
   * @param {HTMLAudioElement} remoteAudio
   * @param {HTMLVideoElement} video
   */
  constructor(remoteAudio, video) {
    super();
    this.remoteAudio = remoteAudio;
    this.video = video;
    this.stream = null;
    this.peer = null;
    this.senders = [];
    this.baseVolume = 1;
    this.ducked = false;
    this.lastSpeech = 0;
    this.ctx = null;
    this.analyser = null;
  }

  get micOn() {
    return !!this.stream && this.stream.getAudioTracks().some((t) => t.enabled && t.readyState === 'live');
  }

  /** Attach to a (new) peer connection; re-sends the mic if it was already on. */
  attach(peer) {
    this.peer = peer;
    this.senders = [];
    peer.addEventListener('track', (e) => {
      if (e.detail.track.kind !== 'audio') return;
      this.remoteAudio.srcObject = e.detail.stream || new MediaStream([e.detail.track]);
      this.remoteAudio.play().catch(() => {});
      this.watchRemote(this.remoteAudio.srcObject);
    });
    if (this.stream) this.addTracks();
  }

  async toggleMic() {
    this.ensureAudioContext();
    if (!this.stream) {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.addTracks();
    } else {
      const track = this.stream.getAudioTracks()[0];
      track.enabled = !track.enabled;
    }
    this.dispatchEvent(new CustomEvent('mic', { detail: this.micOn }));
    return this.micOn;
  }

  addTracks() {
    if (!this.peer || this.peer.closed) return;
    for (const track of this.stream.getAudioTracks()) {
      this.senders.push(this.peer.pc.addTrack(track, this.stream));
    }
  }

  setBaseVolume(v) {
    this.baseVolume = v;
    this.applyVolume();
  }

  applyVolume() {
    this.video.volume = this.baseVolume * (this.ducked ? DUCK_TO : 1);
  }

  ensureAudioContext() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  watchRemote(stream) {
    try {
      this.ensureAudioContext();
    } catch {
      return;
    }
    const src = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    src.connect(this.analyser);
    const data = new Float32Array(this.analyser.fftSize);
    clearInterval(this.meterTimer);
    this.meterTimer = setInterval(() => {
      this.analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (const x of data) sum += x * x;
      const rms = Math.sqrt(sum / data.length);
      const now = performance.now();
      if (rms > SPEAK_THRESHOLD) this.lastSpeech = now;
      const speaking = now - this.lastSpeech < RELEASE_MS;
      if (speaking !== this.ducked) {
        this.ducked = speaking;
        this.applyVolume();
        this.dispatchEvent(new CustomEvent('partner-speaking', { detail: speaking }));
      }
    }, 80);
  }

  stop() {
    clearInterval(this.meterTimer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.ducked = false;
    this.applyVolume();
  }
}
