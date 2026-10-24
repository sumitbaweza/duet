// Player chrome behaviour: auto-hiding controls, tap / double-tap gestures and the seek timeline.
//
//  - Any mouse move, tap or key press shows the top bar + controls; after 3 s of stillness they fade.
//    They stay up while you hover them, scrub, have a popover open, or a status card is showing.
//  - Touch: single tap toggles the controls; double-tap the left/right side seeks −5 s / +5 s
//    (keep tapping to add 5 s more each time); double-tap the middle plays/pauses.
//  - Mouse: click plays/pauses; double-click left/right seeks; double-click the middle is fullscreen.

const HIDE_AFTER_MS = 3000;
const DOUBLE_TAP_MS = 280;
const STREAK_MS = 700; // further taps on the same side within this window add another step
const SEEK_STEP = 5;
const SIDE_ZONE = 0.35; // left/right 35% of the width are seek zones

export class PlayerUI {
  /**
   * @param {{stage: HTMLElement, video: HTMLVideoElement, getDuration: () => number,
   *          getTime?: () => number, onToggle: () => void, onSeek: (t: number) => void,
   *          onFullscreen: () => void}} opts
   */
  constructor({ stage, video, getDuration, getTime, onToggle, onSeek, onFullscreen }) {
    this.stage = stage;
    this.video = video;
    this.getDuration = getDuration;
    // Movie time; differs from video.currentTime when the <video> shows a live stream.
    this.getTime = getTime || (() => video.currentTime);
    this.onToggle = onToggle;
    this.onSeek = onSeek;
    this.onFullscreen = onFullscreen;
    this.locks = new Set();
    this.hideTimer = null;
    this.pendingTap = null;
    this.streak = null;
    this.scrubbing = false;

    this.el = {
      gestures: stage.querySelector('#gestures'),
      timeline: stage.querySelector('#timeline'),
      progress: stage.querySelector('#progress'),
      thumb: stage.querySelector('#thumb'),
      buffered: stage.querySelector('#buffered'),
      hoverTime: stage.querySelector('#hover-time'),
      time: stage.querySelector('#time'),
      center: stage.querySelector('#center-play'),
      ripple: { left: stage.querySelector('#ripple-left'), right: stage.querySelector('#ripple-right') },
    };

    this.bindVisibility();
    this.bindGestures();
    this.bindTimeline();
    this.el.center.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onToggle();
      this.show();
    });
    video.addEventListener('timeupdate', () => this.render());
    video.addEventListener('durationchange', () => this.render());
    video.addEventListener('progress', () => this.renderBuffered());
    this.show();
  }

  // ------------------------------------------------------------------ visibility

  show() {
    this.stage.classList.add('ui-visible');
    this.armHide();
  }

  hide() {
    if (this.locks.size) return;
    this.stage.classList.remove('ui-visible');
  }

  armHide() {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hide(), HIDE_AFTER_MS);
  }

  get visible() {
    return this.stage.classList.contains('ui-visible');
  }

  /** Keep the controls up for a reason (hover, scrub, popover, status card); release re-arms the timer. */
  hold(reason, on) {
    if (on) {
      this.locks.add(reason);
      this.show();
    } else if (this.locks.delete(reason)) {
      this.armHide();
    }
  }

  bindVisibility() {
    let last = { x: -1, y: -1 };
    this.stage.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      // Ignore sub-pixel jitter so a resting mouse doesn't keep the controls up.
      if (Math.abs(e.clientX - last.x) + Math.abs(e.clientY - last.y) < 3) return;
      last = { x: e.clientX, y: e.clientY };
      this.show();
    });
    for (const bar of this.stage.querySelectorAll('.chrome')) {
      bar.addEventListener('pointerenter', (e) => e.pointerType === 'mouse' && this.hold('hover', true));
      bar.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && this.hold('hover', false));
      bar.addEventListener('pointerdown', () => this.show()); // using a control restarts the 3 s
    }
    document.addEventListener('keydown', () => this.show());
  }

  // ------------------------------------------------------------------ taps & double taps

  bindGestures() {
    const g = this.el.gestures;
    let down = null;
    g.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    g.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const held = performance.now() - down.t;
      down = null;
      if (moved > 12 || held > 450) return; // a drag or long-press, not a tap
      this.handleTap(e);
    });
    g.addEventListener('pointercancel', () => (down = null));
    g.addEventListener('dblclick', (e) => e.preventDefault());
  }

  /** Position of a pointer along an element, 0..1 from its left edge, also when the player is
   *  rotated sideways for fullscreen on an upright phone (its left edge is then at the top). */
  along(e, el) {
    const r = el.getBoundingClientRect();
    return this.stage.classList.contains('rotated') ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
  }

  handleTap(e) {
    const x = this.along(e, this.stage);
    const zone = x < SIDE_ZONE ? 'left' : x > 1 - SIDE_ZONE ? 'right' : 'center';
    const touch = e.pointerType !== 'mouse';
    const now = performance.now();

    // Already in a seek streak on this side: every extra tap is another step, immediately.
    if (this.streak && this.streak.zone === zone && now - this.streak.at < STREAK_MS) {
      this.seekStep(zone);
      return;
    }

    if (this.pendingTap && now - this.pendingTap.at < DOUBLE_TAP_MS) {
      clearTimeout(this.pendingTap.timer);
      const first = this.pendingTap;
      this.pendingTap = null;
      if (zone !== 'center' && first.zone === zone) {
        this.streak = { zone, at: now, total: 0 };
        this.seekStep(zone);
      } else if (zone === 'center') {
        if (touch) this.onToggle();
        else this.onFullscreen();
      }
      return;
    }

    this.pendingTap = {
      zone,
      at: now,
      timer: setTimeout(() => {
        this.pendingTap = null;
        if (touch) {
          // Phones: a tap reveals / hides the controls (the big button then plays/pauses).
          if (this.visible && !this.locks.size) this.hide();
          else this.show();
        } else {
          this.onToggle();
          this.show();
        }
      }, DOUBLE_TAP_MS),
    };
  }

  seekStep(zone) {
    const dir = zone === 'left' ? -1 : 1;
    const duration = this.getDuration() || Infinity;
    const target = Math.min(duration, Math.max(0, this.getTime() + dir * SEEK_STEP));
    this.onSeek(target);
    this.streak.at = performance.now();
    this.streak.total += SEEK_STEP;
    this.flashRipple(zone, this.streak.total);
  }

  /** Show the "‹‹‹ 10 seconds" bubble on one side (also used by the arrow keys). */
  flashRipple(zone, seconds) {
    const el = this.el.ripple[zone];
    el.querySelector('b').textContent = `${seconds} seconds`;
    el.classList.remove('show');
    void el.offsetWidth; // restart the chevron animation
    el.classList.add('show');
    clearTimeout(el.hideTimer);
    el.hideTimer = setTimeout(() => {
      el.classList.remove('show');
      if (this.streak?.zone === zone) this.streak = null;
    }, STREAK_MS);
  }

  // ------------------------------------------------------------------ timeline

  bindTimeline() {
    const tl = this.el.timeline;
    const timeAt = (e) => {
      const f = Math.min(1, Math.max(0, this.along(e, tl)));
      return { f, t: f * (this.getDuration() || 0) };
    };
    const showHover = (e) => {
      const { f, t } = timeAt(e);
      const tip = this.el.hoverTime;
      tip.hidden = false;
      tip.textContent = formatTime(t);
      const width = tl.offsetWidth; // unrotated length of the timeline
      const half = tip.offsetWidth / 2;
      tip.style.left = `${Math.min(width - half, Math.max(half, f * width))}px`;
    };

    tl.addEventListener('pointerdown', (e) => {
      if (!this.getDuration()) return;
      e.preventDefault();
      tl.setPointerCapture(e.pointerId);
      this.scrubbing = true;
      tl.classList.add('scrubbing');
      this.hold('scrub', true);
      this.paintProgress(timeAt(e).t);
      showHover(e);
    });
    tl.addEventListener('pointermove', (e) => {
      if (this.scrubbing) this.paintProgress(timeAt(e).t);
      if (this.scrubbing || e.pointerType === 'mouse') showHover(e);
    });
    const end = (e) => {
      if (!this.scrubbing) return;
      this.scrubbing = false;
      tl.classList.remove('scrubbing');
      this.el.hoverTime.hidden = true;
      this.onSeek(timeAt(e).t);
      this.hold('scrub', false);
    };
    tl.addEventListener('pointerup', end);
    tl.addEventListener('pointercancel', end);
    tl.addEventListener('pointerleave', () => {
      if (!this.scrubbing) this.el.hoverTime.hidden = true;
    });
  }

  paintProgress(t) {
    const d = this.getDuration() || 0;
    const pct = d ? Math.min(100, (t / d) * 100) : 0;
    this.el.progress.style.width = `${pct}%`;
    this.el.thumb.style.left = `${pct}%`;
    this.el.time.innerHTML = `${formatTime(t)} <span class="muted">/ ${formatTime(d)}</span>`;
    const tl = this.el.timeline;
    tl.setAttribute('aria-valuemax', String(Math.round(d)));
    tl.setAttribute('aria-valuenow', String(Math.round(t)));
    tl.setAttribute('aria-valuetext', `${formatTime(t)} of ${formatTime(d)}`);
  }

  render() {
    if (!this.scrubbing) this.paintProgress(this.getTime());
    this.renderBuffered();
  }

  renderBuffered() {
    const d = this.getDuration();
    const el = this.el.buffered;
    if (!d) return void (el.innerHTML = '');
    const r = this.video.buffered;
    let html = '';
    for (let i = 0; i < r.length; i++) {
      html += `<i style="left:${(r.start(i) / d) * 100}%;width:${((r.end(i) - r.start(i)) / d) * 100}%"></i>`;
    }
    el.innerHTML = html;
  }

  // ------------------------------------------------------------------ state from the app

  setPlaying(playing) {
    this.stage.classList.toggle('playing', playing);
    this.el.center.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  setHasMedia(has) {
    this.stage.classList.toggle('has-media', has);
  }

  /** A status card (waiting / buffering / pick a movie) is up: keep the chrome visible, hide the big button. */
  setBusy(busy) {
    this.stage.classList.toggle('busy', busy);
    this.hold('status', busy);
  }
}

export function formatTime(s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
