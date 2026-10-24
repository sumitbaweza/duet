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
    this.baseVolume = 1; // movie level chosen by the user
    this.callVolume = 1; // partner's voice level chosen by the user
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
      if (e.detail.stream && e.detail.stream.id === peer.compatStreamId) return; // movie sound, not voice
      this.remoteAudio.srcObject = e.detail.stream || new MediaStream([e.detail.track]);
      this.remoteAudio.play().catch(() => {});
      this.watchRemote(this.remoteAudio.srcObject);
    });
    if (this.stream) this.sendTrack();
  }

  async toggleMic() {
    this.ensureAudioContext();
    if (this.micOn) this.stopMic();
    else await this.startMic();
    this.dispatchEvent(new CustomEvent('mic', { detail: this.micOn }));
    return this.micOn;
  }

  async startMic() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.sendTrack();
  }

  /**
   * Release the microphone completely. Only muting it would keep it open, and phones then show the
   * browser as still using the mic (Android's green dot) even though the button says off.
   */
  stopMic() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    for (const sender of this.senders) sender.replaceTrack(null).catch(() => {});
  }

  /** Send the mic to the partner: into the existing sender if there is one (no renegotiation). */
  sendTrack() {
    if (!this.peer || this.peer.closed || !this.stream) return;
    const track = this.stream.getAudioTracks()[0];
    if (!track) return;
    if (this.senders.length) {
      this.senders[0].replaceTrack(track).catch((err) => console.warn('replaceTrack', err));
    } else {
      this.senders.push(this.peer.pc.addTrack(track, this.stream));
    }
  }

  setBaseVolume(v) {
    this.baseVolume = v;
    this.applyVolume();
  }

  setCallVolume(v) {
    this.callVolume = v;
    this.remoteAudio.volume = v;
    setMuted(this.remoteAudio, v === 0);
  }

  applyVolume() {
    this.video.volume = this.baseVolume * (this.ducked ? DUCK_TO : 1);
    setMuted(this.video, this.baseVolume === 0);
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

/**
 * Mute for a level of 0, as well as setting .volume: iPhone/iPad ignore .volume (only the side
 * buttons change it), but they do honour muting. Only ever unmutes what was muted here.
 */
function setMuted(el, mute) {
  if (mute && !el.muted) {
    el.muted = true;
    el.duetMuted = true;
  } else if (!mute && el.duetMuted) {
    el.muted = false;
    el.duetMuted = false;
  }
}
