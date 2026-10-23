// Keeps both <video> elements on the same frame.
//
// - Either person can play / pause / seek; the action is applied locally and sent to the other side.
// - The host is the clock: it sends a heartbeat every second and the guest corrects drift with
//   tiny playbackRate nudges (0.95x–1.05x), or a hard seek when it's more than a second off.
// - If either side runs out of buffered video, both pause until it has a few seconds again.
// - Remote-control mode (guest in compatibility mode): the guest's <video> shows the host's live
//   picture, so the guest never seeks or pauses it; its buttons only send commands, and the clock
//   shown is estimated from the host's heartbeats.

const HEARTBEAT_MS = 1000;
const PING_MS = 2000;
const CHECK_MS = 250;
const RESUME_AHEAD = 3; // seconds of buffer needed before resuming after a stall (grows if stalls repeat)
const MAX_RESUME_AHEAD = 30;
const RESTALL_WINDOW_MS = 20_000; // stalling again this soon after resuming doubles the cushion
const RELAX_AFTER_MS = 60_000; // smooth playback this long halves it again
const SEEK_GRACE_MS = 2000; // running dry right after a seek is expected, not a sign of a slow link
const STALL_AHEAD = 0.25;
const HARD_SEEK_DRIFT = 1.0;
const SOFT_DRIFT = 0.08;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class SyncEngine extends EventTarget {
  /**
   * @param {{video: HTMLVideoElement, role: 'host'|'guest', send: (msg: object) => void,
   *          bufferedAhead: () => number, hasMedia: () => boolean, duration: () => number,
   *          bufferLimit?: () => number}} opts
   */
  constructor({ video, role, send, bufferedAhead, hasMedia, duration, bufferLimit }) {
    super();
    this.video = video;
    this.role = role;
    this.send = send;
    this.bufferedAhead = bufferedAhead;
    this.hasMedia = hasMedia;
    this.duration = duration;
    this.bufferLimit = bufferLimit || (() => 90); // most seconds the player will ever buffer ahead
    this.resumeAhead = RESUME_AHEAD;
    this.lastResumeAt = 0;

    this.intent = false; // what the two people want: playing or paused
    this.localBuffering = false;
    this.peerBuffering = false;
    this.rtt = 0.1;
    this.rttSamples = [];
    this.lastLocalAction = 0;
    this.expectPlay = 0; // count of play/pause/seek calls we made ourselves (vs. native controls)
    this.expectPause = 0;
    this.expectSeek = 0;
    this.lastSeekAt = 0;
    this.remoteMode = false;
    this.remote = { time: 0, playing: false, at: performance.now() }; // last host heartbeat

    this.listeners = {
      play: () => this.onNativePlay(),
      pause: () => this.onNativePause(),
      seeking: () => this.onNativeSeeking(),
      waiting: () => this.checkBuffer(),
    };
    for (const [ev, fn] of Object.entries(this.listeners)) video.addEventListener(ev, fn);

    this.timers = [
      setInterval(() => this.checkBuffer(), CHECK_MS),
      setInterval(() => this.send({ t: 'ping', ts: performance.now() }), PING_MS),
    ];
    if (role === 'host') this.timers.push(setInterval(() => this.heartbeat(), HEARTBEAT_MS));
  }

  /** Guest in compatibility mode: show the host's live picture and act as a remote control. */
  setRemoteControl(on) {
    this.remoteMode = on;
    this.video.playbackRate = 1;
    // A live picture never buffers: tell the host we're ready (it may be waiting for us after a
    // rejoin, or we may have said "buffering" before switching).
    if (on) this.send({ t: 'buffering', on: false });
    this.localBuffering = false;
    this.update();
  }

  /** Movie time: the <video>'s own clock, or (remote control) estimated from the host's heartbeat. */
  currentTime() {
    if (!this.remoteMode) return this.video.currentTime;
    const r = this.remote;
    const elapsed = r.playing ? (performance.now() - r.at) / 1000 : 0;
    return Math.min(this.duration() || Infinity, r.time + elapsed);
  }

  // ---- user actions (custom controls) ----

  play() {
    this.lastLocalAction = performance.now();
    this.intent = true;
    if (this.video.ended && !this.remoteMode) this.setTime(0); // play again from the start
    const time = this.currentTime();
    if (this.remoteMode) this.remote = { time, playing: true, at: performance.now() };
    this.send({ t: 'play', time });
    this.update();
  }

  pause() {
    this.lastLocalAction = performance.now();
    this.intent = false;
    const time = this.currentTime();
    if (this.remoteMode) this.remote = { time, playing: false, at: performance.now() };
    this.send({ t: 'pause', time });
    this.update();
  }

  toggle() {
    this.intent ? this.pause() : this.play();
  }

  seek(time) {
    this.lastLocalAction = this.lastSeekAt = performance.now();
    time = clamp(time, 0, this.duration() || Infinity);
    if (this.remoteMode) this.remote = { time, playing: this.remote.playing, at: performance.now() };
    else this.setTime(time);
    this.send({ t: 'seek', time });
    this.update();
  }

  // ---- remote messages ----

  handle(msg) {
    if (this.remoteMode && (msg.t === 'play' || msg.t === 'pause' || msg.t === 'seek')) {
      if (msg.t !== 'seek') this.intent = msg.t === 'play';
      this.remote = { time: msg.time, playing: this.intent, at: performance.now() };
      return this.update();
    }
    switch (msg.t) {
      case 'play':
        this.intent = true;
        if (Math.abs(this.video.currentTime - msg.time) > 0.7) this.setTime(msg.time + this.rtt / 2);
        break;
      case 'pause':
        this.intent = false;
        this.setTime(msg.time);
        break;
      case 'seek':
        this.lastSeekAt = performance.now();
        this.setTime(msg.time);
        break;
      case 'buffering':
        this.peerBuffering = msg.on;
        // Host restarts from wherever the guest's buffer is so neither skips a scene.
        if (!msg.on && this.role === 'host' && Math.abs(this.video.currentTime - msg.time) > 0.5) {
          this.setTime(msg.time);
        }
        break;
      case 'hb':
        if (this.role === 'guest') this.onHeartbeat(msg);
        return;
      case 'ping':
        this.send({ t: 'pong', ts: msg.ts });
        return;
      case 'pong':
        // Minimum of recent samples: jitter and throttled tabs only ever add delay, so the
        // smallest round trip is the best estimate of the true network latency.
        this.rttSamples.push((performance.now() - msg.ts) / 1000);
        if (this.rttSamples.length > 10) this.rttSamples.shift();
        this.rtt = Math.min(...this.rttSamples);
        return;
      default:
        return;
    }
    this.update();
  }

  heartbeat() {
    this.send({
      t: 'hb',
      time: this.video.currentTime,
      playing: !this.video.paused,
      intent: this.intent,
    });
  }

  onHeartbeat(msg) {
    // A heartbeat sent before the host saw our latest click would undo it; ignore those briefly.
    if (performance.now() - this.lastLocalAction < 1500) return;
    if (this.remoteMode) {
      this.remote = { time: msg.time + (msg.playing ? this.rtt / 2 : 0), playing: msg.playing, at: performance.now() };
      this.intent = msg.intent;
      return this.update();
    }
    const v = this.video;
    const intentChanged = this.intent !== msg.intent;
    this.intent = msg.intent;
    if (!msg.playing) {
      // Host is paused (or waiting for us to buffer): stand on the same frame it is on.
      // This is also how a guest who joins mid-movie jumps to the right place.
      if (Math.abs(v.currentTime - msg.time) > (this.intent ? HARD_SEEK_DRIFT : 0.3)) this.setTime(msg.time);
      v.playbackRate = 1;
    }
    if (intentChanged) {
      if (this.intent) this.announceReadiness();
      this.update();
    }
    if (!msg.playing) return this.emitState();
    if (v.paused || this.localBuffering || v.seeking) return;
    const expected = msg.time + this.rtt / 2;
    const drift = v.currentTime - expected;
    if (Math.abs(drift) > HARD_SEEK_DRIFT) {
      v.playbackRate = 1;
      this.setTime(expected + 0.15);
    } else if (Math.abs(drift) > SOFT_DRIFT) {
      v.playbackRate = 1 - clamp(drift * 0.3, -0.05, 0.05);
    } else {
      v.playbackRate = 1;
    }
    this.emitState(drift);
  }

  /** Host: hold playback until the partner reports it has buffered (e.g. right after a rejoin). */
  waitForPeer() {
    this.peerBuffering = true;
    this.update();
  }

  /** Tell the host whether we can play right now, so a host in waitForPeer() knows when to go. */
  announceReadiness() {
    this.checkBuffer(); // sends {buffering:on} itself if we have no data yet
    if (!this.localBuffering) this.send({ t: 'buffering', on: false, time: this.video.currentTime });
  }

  // ---- applying state to the <video> ----

  get shouldPlay() {
    return this.intent && !this.localBuffering && !this.peerBuffering && this.hasMedia();
  }

  update() {
    const v = this.video;
    if (this.remoteMode) {
      // A live picture: keep it running; the host's pause freezes the frames.
      if (v.paused && v.srcObject) v.play().catch(() => this.dispatchEvent(new Event('autoplay-blocked')));
      return this.emitState();
    }
    if (this.shouldPlay && v.paused && !v.ended) {
      this.expectPlay++;
      v.play().catch((err) => {
        this.expectPlay = Math.max(0, this.expectPlay - 1);
        if (err.name === 'NotAllowedError') this.dispatchEvent(new Event('autoplay-blocked'));
      });
    } else if (!this.shouldPlay && !v.paused) {
      this.expectPause++;
      v.pause();
    }
    this.emitState();
  }

  setTime(t) {
    if (!Number.isFinite(t)) return;
    // With no media loaded yet no 'seeking' event fires, so don't expect one.
    if (this.video.readyState > 0) this.expectSeek++;
    this.video.currentTime = Math.max(0, t);
  }

  checkBuffer() {
    if (this.remoteMode || (!this.intent && !this.localBuffering)) return;
    const v = this.video;
    const now = performance.now();
    const ahead = this.hasMedia() ? this.bufferedAhead() : 0;
    const nearEnd = this.duration() && v.currentTime + ahead >= this.duration() - 0.5;
    if (!this.localBuffering && this.intent && ahead < STALL_AHEAD && !nearEnd) {
      // Ran dry again soon after resuming: the link is slower than the movie right now, so wait
      // for a bigger cushion before resuming instead of flickering between play and "Buffering…".
      if (this.lastResumeAt && now - this.lastResumeAt < RESTALL_WINDOW_MS && now - this.lastSeekAt > SEEK_GRACE_MS) {
        this.resumeAhead = Math.min(MAX_RESUME_AHEAD, this.resumeAhead * 2);
      }
      this.localBuffering = true;
      this.send({ t: 'buffering', on: true, time: v.currentTime });
      this.update();
    } else if (this.localBuffering && (ahead >= this.resumeTarget() || nearEnd || !this.intent)) {
      this.localBuffering = false;
      this.lastResumeAt = now;
      this.send({ t: 'buffering', on: false, time: v.currentTime });
      this.update();
    } else if (!this.localBuffering && this.resumeAhead > RESUME_AHEAD && now - this.lastResumeAt > RELAX_AFTER_MS) {
      this.resumeAhead = Math.max(RESUME_AHEAD, this.resumeAhead / 2);
      this.lastResumeAt = now;
    }
  }

  /** Seconds of buffer to wait for before resuming (never more than the player can hold). */
  resumeTarget() {
    return Math.max(1, Math.min(this.resumeAhead, this.bufferLimit() - 2));
  }

  // ---- native control events (e.g. iPhone fullscreen player) ----

  onNativePlay() {
    if (this.remoteMode) return;
    if (this.expectPlay > 0) return void this.expectPlay--;
    if (!this.intent) this.play();
  }

  onNativePause() {
    if (this.remoteMode) return;
    if (this.expectPause > 0) return void this.expectPause--;
    if (this.video.ended) {
      this.intent = false;
      return this.emitState();
    }
    if (this.intent) this.pause();
  }

  onNativeSeeking() {
    if (this.remoteMode) return;
    if (this.expectSeek > 0) return void this.expectSeek--;
    this.lastLocalAction = this.lastSeekAt = performance.now();
    this.send({ t: 'seek', time: this.video.currentTime });
  }

  emitState(drift) {
    this.dispatchEvent(
      new CustomEvent('state', {
        detail: {
          intent: this.intent,
          localBuffering: this.localBuffering,
          peerBuffering: this.peerBuffering,
          resumeAhead: this.resumeTarget(),
          rttMs: Math.round(this.rtt * 1000),
          drift,
        },
      })
    );
  }

  destroy() {
    this.timers.forEach(clearInterval);
    for (const [ev, fn] of Object.entries(this.listeners)) this.video.removeEventListener(ev, fn);
  }
}
