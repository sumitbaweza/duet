import { Peer } from './peer.js';
import { HostStreamer } from './host-streamer.js';
import { GuestPlayer, mseSupported } from './guest-player.js';
import { SyncEngine } from './sync.js';
import { Voice } from './voice.js';
import { Camera } from './camera.js';
import { PlayerUI } from './player-ui.js';
import { LocalPlayer } from './local-player.js';
import { CompatSender, canCapture } from './compat.js';
import { readableFile, clearMovieCopies } from './file-access.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const stage = $('stage');
const voice = new Voice($('remote-audio'), video);
const camera = new Camera({ selfVideo: $('self-cam'), partnerVideo: $('partner-cam') });
const socket = window.io({ autoConnect: true });

const state = {
  role: null, // 'host' | 'guest'
  code: null,
  token: null,
  peerName: null,
  iceServers: null,
  peer: null,
  sync: null,
  streamer: null, // host only
  player: null, // guest only
  file: null, // host only
  fileUrl: null,
  localPlayer: null, // host only: plays MKV/WebM/AC-3… files through the conversion pipeline
  nativeOnly: false, // host only: file can't be streamed as data, only played here and sent live
  compatSender: null, // host only: live-video fallback ("compatibility mode")
  compat: null, // guest only: {streamId, stream} while watching the host's live picture
  compatPending: false, // guest only: told the host we can't decode; waiting for the live stream
  abr: null, // auto-quality state from the host's streamer: {quality, current, linkBps, movieBps, …}
  bufferingSince: null, // when the current buffering started (to avoid flashing the card)
  bufferingTimer: null,
  duration: 0,
  pendingSignals: [],
  lastBytes: 0,
  lastBytesAt: performance.now(),
  guestStatus: null,
};
const debug = new URLSearchParams(location.search).has('debug');
const dlog = (...args) => debug && console.log(`[duet ${(performance.now() / 1000).toFixed(2)}]`, ...args);
if (debug) {
  window.duet = state;
  socket.onAny((ev, data) => dlog('socket <-', ev, data?.description?.type ?? (data?.candidate ? 'candidate' : '')));
}

const ui = new PlayerUI({
  stage,
  video,
  getDuration: () => state.duration || (Number.isFinite(video.duration) ? video.duration : 0),
  getTime: () => (state.sync ? state.sync.currentTime() : video.currentTime),
  onToggle: () => {
    unlockMedia();
    state.sync?.toggle();
  },
  onSeek: (t) => state.sync?.seek(t),
  onFullscreen: () => toggleFullscreen(),
});

// ---------------------------------------------------------------- home screen

const savedName = safeGet(localStorage, 'duet:name');
if (savedName) $('name').value = savedName;
const params = new URLSearchParams(location.search);

function selectTab(which) {
  const join = which === 'join';
  document.querySelector('.tabs').classList.toggle('join', join);
  $('tab-create').classList.toggle('active', !join);
  $('tab-join').classList.toggle('active', join);
  $('tab-create').setAttribute('aria-selected', String(!join));
  $('tab-join').setAttribute('aria-selected', String(join));
  $('panel-create').hidden = join;
  $('join-form').hidden = !join;
  showHomeError('');
}
$('tab-create').onclick = () => selectTab('create');
$('tab-join').onclick = () => {
  selectTab('join');
  codeBoxes.find((b) => !b.value)?.focus();
};

// Six one-letter boxes that behave like one field: type to advance, backspace to go back, paste fills all.
const codeBoxes = [...document.querySelectorAll('#code-boxes input')];
const CODE_CHARS = /[^ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/g;
function setCode(text, from = 0) {
  const chars = text.toUpperCase().replace(CODE_CHARS, '').slice(0, 6 - from).split('');
  chars.forEach((c, i) => (codeBoxes[from + i].value = c));
  codeBoxes.forEach((b) => b.classList.toggle('filled', !!b.value));
  const next = codeBoxes.find((b) => !b.value);
  (next || codeBoxes[5]).focus();
}
const getCode = () => codeBoxes.map((b) => b.value).join('');
codeBoxes.forEach((box, i) => {
  box.addEventListener('input', () => {
    const v = box.value;
    box.value = '';
    setCode(v, i);
    if (getCode().length === 6) $('join-form').requestSubmit();
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !box.value && i > 0) {
      codeBoxes[i - 1].value = '';
      codeBoxes[i - 1].classList.remove('filled');
      codeBoxes[i - 1].focus();
      e.preventDefault();
    } else if (e.key === 'ArrowLeft' && i > 0) codeBoxes[i - 1].focus();
    else if (e.key === 'ArrowRight' && i < 5) codeBoxes[i + 1].focus();
  });
  box.addEventListener('paste', (e) => {
    e.preventDefault();
    codeBoxes.forEach((b) => (b.value = ''));
    setCode(e.clipboardData.getData('text'));
  });
  box.addEventListener('focus', () => box.select());
});

if (params.get('room')) {
  selectTab('join');
  codeBoxes.forEach((b) => (b.value = ''));
  setCode(params.get('room'));
  $('name').focus();
}

$('create').onclick = () => {
  const name = requireName();
  if (!name) return;
  withTerms('Accept & create room', () => {
    unlockMedia();
    socket.emit('create-room', { name, terms: TERMS_VERSION }, onJoined);
  });
};
$('join-form').onsubmit = (e) => {
  e.preventDefault();
  const name = requireName();
  if (!name) return;
  const code = getCode();
  if (code.length !== 6) {
    $('code-boxes').classList.remove('shake');
    void $('code-boxes').offsetWidth;
    $('code-boxes').classList.add('shake');
    return showHomeError('Room codes are 6 characters.');
  }
  withTerms('Accept & join room', () => {
    unlockMedia();
    const saved = loadSession();
    const token = saved?.code === code ? saved.token : undefined;
    socket.emit('join-room', { code, name, token, terms: TERMS_VERSION }, onJoined);
  });
};

// Terms of Service / Privacy Policy: accepted once per device, and again whenever they change
// (bump TERMS_VERSION here and in server/index.js together).
const TERMS_VERSION = '2026-10-24';
const TERMS_KEY = 'duet:terms';
let termsProceed = null;
let termsReturnFocus = null;

function withTerms(acceptLabel, proceed) {
  if (safeGet(localStorage, TERMS_KEY) === TERMS_VERSION) return proceed();
  termsProceed = proceed;
  termsReturnFocus = document.activeElement;
  $('terms-accept').textContent = acceptLabel;
  $('terms-modal').hidden = false;
  document.body.classList.add('modal-open');
  $('terms-accept').focus();
}
function closeTerms() {
  $('terms-modal').hidden = true;
  document.body.classList.remove('modal-open');
  termsProceed = null;
  termsReturnFocus?.focus?.();
}
$('terms-accept').onclick = () => {
  const proceed = termsProceed;
  safeSet(localStorage, TERMS_KEY, TERMS_VERSION);
  closeTerms();
  proceed?.();
};
$('terms-cancel').onclick = closeTerms;
$('terms-modal').addEventListener('click', (e) => {
  if (e.target === $('terms-modal')) closeTerms(); // tap outside the card
});
$('terms-modal').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') return closeTerms();
  if (e.key !== 'Tab') return;
  // Keep keyboard focus inside the dialog.
  const items = [...$('terms-modal').querySelectorAll('a[href], button')];
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});
$('cta-start').addEventListener('click', (e) => {
  e.preventDefault();
  $('home-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => $('name').focus({ preventScroll: true }), 450);
});

function myName() {
  const name = $('name').value.trim().replace(/\s+/g, ' ');
  if (name) safeSet(localStorage, 'duet:name', name);
  return name;
}

/** The name is required: point at the empty field instead of starting a session. */
function requireName() {
  const name = myName();
  if (name) return name;
  const field = $('name');
  field.classList.remove('invalid', 'shake');
  void field.offsetWidth; // restart the shake animation
  field.classList.add('invalid', 'shake');
  field.focus();
  showHomeError('Please enter your name so your partner knows who joined.');
  return null;
}
$('name').addEventListener('input', () => {
  if (!$('name').value.trim()) return;
  $('name').classList.remove('invalid');
  if ($('home-error').textContent.startsWith('Please enter your name')) showHomeError('');
});

function showHomeError(msg) {
  $('home-error').textContent = msg;
}

// Resume after a refresh / reconnect.
socket.on('connect', () => {
  const saved = loadSession();
  if (saved && (state.code || !params.get('room') || params.get('room').toUpperCase() === saved.code)) {
    socket.emit('join-room', { code: saved.code, token: saved.token, name: myName() }, (res) => {
      if (res.ok) onJoined(res);
      else clearSession();
    });
  }
});

async function onJoined(res) {
  dlog('joined', res?.ok, res?.role, 'peerOnline', res?.peerOnline);
  if (!res?.ok) {
    if (res?.field === 'name') return requireName();
    if (res?.field === 'terms') {
      safeSet(localStorage, TERMS_KEY, ''); // the server has newer terms: ask again
      return showHomeError(res.error);
    }
    return showHomeError(res?.error || 'Something went wrong.');
  }
  const reconnect = state.code === res.state.code;
  // The partner rebuilds its connection when we (re)join, so ours is stale; drop it now so their
  // offer gets queued instead of landing on the old RTCPeerConnection while we await below.
  if (reconnect) teardownPeer({ keepPendingSignals: true });
  state.role = res.role;
  state.code = res.state.code;
  state.token = res.token;
  saveSession({ code: state.code, token: state.token, role: state.role });
  history.replaceState(null, '', `/?room=${state.code}${window.duet ? '&debug' : ''}`);
  state.iceServers ??= await fetch('/api/ice-servers')
    .then((r) => r.json())
    .then((j) => j.iceServers)
    .catch(() => [{ urls: 'stun:stun.l.google.com:19302' }]);
  if (!reconnect) enterRoom();
  setPartner(res.peerOnline ? res.peerName : null);
  if (res.peerOnline) startPeer();
  else refreshOverlay();
}

function enterRoom() {
  $('home').hidden = true;
  $('room').hidden = false;
  $('room-code').textContent = state.code;
  const isHost = state.role === 'host';
  $('change-file').hidden = !isHost;
  if (!isHost && !mseSupported()) {
    toast("This browser can't receive streams (no Media Source support). Try Chrome, Edge, Firefox, or iOS 17.1+.", 8000);
  }
  refreshOverlay();
  ui.show();
}

// ---------------------------------------------------------------- signaling

socket.on('signal', (data) => {
  if (state.peer) state.peer.handleSignal(data);
  else state.pendingSignals.push(data);
});

socket.on('peer-joined', ({ name }) => {
  setPartner(name);
  toast(`${name} joined`);
  startPeer();
});

socket.on('peer-left', ({ permanent }) => {
  toast(permanent ? 'Your partner left the room' : 'Your partner disconnected — waiting for them…');
  setPartner(null);
  // Hold the movie so nobody misses a scene; it resumes once they're back and buffered.
  if (state.role === 'host' && !video.paused) {
    state.resumeOnRejoin = true;
    video.pause();
  }
  teardownPeer();
  refreshOverlay();
});

socket.on('room-closed', () => {
  clearSession();
  teardownPeer();
  alert('This room was closed.');
  location.href = '/';
});

$('leave').onclick = () => {
  socket.emit('leave-room');
  clearSession();
  teardownPeer();
  voice.stop();
  camera.stop();
  location.href = '/';
};

// ---------------------------------------------------------------- peer lifecycle

function startPeer() {
  dlog('startPeer', state.role);
  // Keep signals that raced ahead of us (the partner's offer often arrives before this runs).
  teardownPeer({ keepPendingSignals: true });
  const peer = new Peer({
    polite: state.role === 'guest',
    iceServers: state.iceServers,
    sendSignal: (data) => {
      dlog('signal ->', data.description?.type ?? 'candidate');
      socket.emit('signal', data);
    },
  });
  state.peer = peer;
  voice.attach(peer);
  camera.attach(peer);

  peer.addEventListener('control', (e) => onControl(e.detail));
  peer.addEventListener('open', () => {
    refreshOverlay();
    if (state.role === 'host' && state.file) startStreaming();
  });
  peer.addEventListener('state', (e) => {
    dlog('pc state', e.detail);
    if (e.detail === 'connected') updateLinkInfo();
    if (e.detail === 'failed' || e.detail === 'disconnected') setLink('Reconnecting…', 'bad');
  });

  if (state.role === 'guest') {
    const player = (state.player = new GuestPlayer(video, peer));
    // The host picked a movie: show its name right away (even if it ends up in compatibility mode).
    player.addEventListener('movie', (e) => {
      $('stat-file').textContent = `${e.detail.name} · ${formatBytes(e.detail.size)}`;
      setNowPlaying(e.detail.name);
    });
    player.addEventListener('meta', (e) => {
      state.compatPending = false;
      state.duration = e.detail.duration;
      refreshOverlay();
      ui.render();
    });
    player.addEventListener('warning', (e) => toast(e.detail, 6000));
    player.addEventListener('error', (e) => {
      toast(e.detail, 10000);
      refreshOverlay(e.detail);
    });
    player.addEventListener('unsupported', () => {
      state.compatPending = true; // the host answers with compatibility mode
      refreshOverlay();
    });
    // Compatibility mode: the movie arrives as a live track; show it in the main player.
    peer.addEventListener('track', (e) => {
      const stream = e.detail.stream;
      if (!state.compat || !stream || stream.id !== state.compat.streamId) return;
      state.compat.stream = stream;
      video.srcObject = stream;
      video.play().catch(() => {});
      state.sync?.update();
      refreshOverlay();
    });
  }

  const sync = (state.sync = new SyncEngine({
    video,
    role: state.role,
    send: (msg) => peer.sendControl(msg),
    bufferedAhead: () =>
      state.role === 'host'
        ? state.localPlayer?.bufferedAhead() ?? Infinity
        : state.compat
          ? Infinity
          : state.player.bufferedAhead(),
    hasMedia: () =>
      state.role === 'host'
        ? !!state.file && (!state.localPlayer || !!state.localPlayer.meta)
        : !!state.player?.meta || !!state.compat?.stream,
    duration: () => state.duration,
    bufferLimit: () =>
      (state.role === 'host' ? state.localPlayer?.player.aheadLimit : state.player?.aheadLimit) ?? 90,
  }));
  if (state.role === 'host' && state.file && state.resumeOnRejoin) {
    // Partner is back after dropping mid-movie: resume once they've buffered this spot.
    sync.intent = true;
    sync.waitForPeer();
  }
  state.resumeOnRejoin = false;
  sync.addEventListener('state', (e) => onSyncState(e.detail));
  // A remote "play" refused for lack of a tap: show a tap-to-start button.
  sync.addEventListener('autoplay-blocked', () => {
    sync.blocked = true;
    refreshOverlay();
  });

  for (const s of state.pendingSignals.splice(0)) peer.handleSignal(s);
  refreshOverlay();
}

function teardownPeer({ keepPendingSignals = false } = {}) {
  // Stop sync first: closing the player empties the <video>, and a sync engine still listening
  // would report that as the user pressing pause.
  state.sync?.destroy();
  state.sync = null;
  state.streamer?.close();
  state.streamer = null;
  state.player?.close();
  state.player = null;
  state.peer?.close();
  state.peer = null;
  state.compatSender = null;
  if (state.compat) {
    video.srcObject = null;
    state.compat = null;
  }
  state.compatPending = false;
  camera.setPartner(false);
  if (!keepPendingSignals) state.pendingSignals = [];
  state.guestStatus = null;
  state.abr = null;
  renderQuality();
  setLink(null);
  ui.setPlaying(false);
  if (state.role === 'guest') {
    state.duration = 0;
    $('stat-file').textContent = '—';
    setNowPlaying(null);
  }
}

/** Show the movie's name at the top of the player ("Gajab.Raat.2026.720p.mkv" → "Gajab Raat 2026 720p"). */
function setNowPlaying(fileName) {
  let title = (fileName || '').replace(/\.[a-z0-9]{2,4}$/i, '');
  if (!/\s/.test(title)) title = title.replace(/[._]+/g, ' ');
  title = title.trim();
  $('np-title').textContent = title;
  $('np-title').title = fileName || '';
  $('now-playing').hidden = !title;
}

function onControl(msg) {
  switch (msg.t) {
    case 'accept':
      state.streamer
        ?.begin(msg.tracks, video.currentTime, { canOriginal: msg.canOriginal, canAvc: msg.canAvc })
        .catch((err) => {
          console.warn('Streaming could not start:', err.message);
          startCompat('guest');
        });
      break;
    case 'quality': // partner picked a quality in their menu
      state.streamer?.setQuality?.(msg.value);
      break;
    case 'abr': // host's auto-quality state, for our menu and stats
      state.abr = msg.state;
      renderQuality();
      break;
    case 'reject':
      if (msg.code === 'codec') startCompat('guest');
      else toast(msg.reason, 10000);
      break;
    case 'compat':
      if (msg.on) enterCompat(msg);
      else exitCompat();
      break;
    case 'compat-ready':
      state.compatSender?.onReady();
      break;
    case 'compat-unavailable':
      state.compatPending = false;
      refreshOverlay(msg.reason);
      break;
    case 'need':
      state.streamer?.seek(msg.time);
      break;
    case 'status':
      state.guestStatus = msg;
      state.streamer?.updateGuestStatus(msg);
      break;
    case 'react':
      floatReaction(msg.emoji);
      break;
    case 'cam':
      camera.setPartner(msg.on);
      break;
    default:
      state.sync?.handle(msg);
  }
}

// ---------------------------------------------------------------- host: choosing & streaming a file

$('pick-file').onclick = $('change-file').onclick = () => $('file').click();
clearMovieCopies(); // copies left over from an earlier visit

$('file').onchange = () => {
  const file = $('file').files[0];
  $('file').value = '';
  if (file) loadFile(file);
};

// Drag a movie onto the player (host only).
let dragDepth = 0;
stage.addEventListener('dragenter', (e) => {
  if (state.role !== 'host' || !e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  $('drop-hint').hidden = false;
});
stage.addEventListener('dragover', (e) => {
  if (state.role === 'host') e.preventDefault();
});
stage.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('drop-hint').hidden = true;
  }
});
stage.addEventListener('drop', (e) => {
  if (state.role !== 'host') return;
  e.preventDefault();
  dragDepth = 0;
  $('drop-hint').hidden = true;
  const file = [...(e.dataTransfer?.files ?? [])].find(
    (f) => /^video\//.test(f.type) || VIDEO_EXTENSIONS.test(f.name)
  );
  if (file) loadFile(file);
  else toast('Drop a video file (MP4, MOV, MKV, WebM…).');
});
const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|mkv|webm|ts|m2ts|mts|ogv|avi|wmv|flv)$/i;

async function loadFile(file) {
  const loading = (state.loading = {}); // a newer pick supersedes this one
  // Some phones can only read the picked video front to back, or not at all: check, copy if needed.
  try {
    file = await readableFile(file, (fraction) => {
      const pct = Math.floor(fraction * 100);
      if (state.loading !== loading || pct === state.preparing) return;
      state.preparing = pct;
      refreshOverlay();
    });
  } catch (err) {
    if (state.loading === loading) toast(err.message, 15000);
    return;
  } finally {
    if (state.loading === loading && state.preparing != null) {
      state.preparing = null;
      refreshOverlay();
    }
  }
  if (state.loading !== loading) return;
  // Validate before telling the partner anything.
  const probe = new HostStreamer(file);
  let meta;
  let nativeOnly = false;
  try {
    meta = await probe.probe();
  } catch (err) {
    // Can't be streamed as data. If this browser can still play it, send it live instead.
    nativeOnly = canCapture(video) && (await playsHere(file));
    if (!nativeOnly) {
      toast(err.message, 10000);
      return;
    }
  } finally {
    probe.close();
  }
  state.compatSender?.stop();
  state.compatSender = null;
  state.file = file;
  setNowPlaying(file.name); // now, not after loading: the old movie is being replaced from here on
  state.nativeOnly = nativeOnly;
  state.duration = 0; // the new movie's length is known once its metadata loads
  // A new movie starts paused. Done before the loading below so a "play" pressed meanwhile sticks.
  if (state.sync) {
    state.sync.intent = false;
    state.sync.update();
  }
  state.localPlayer?.close();
  state.localPlayer = null;
  if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
  state.fileUrl = null;
  if (!nativeOnly && probe.mode === 'remux') {
    // The browser can't play this file directly: play it through the conversion pipeline.
    const local = (state.localPlayer = new LocalPlayer(file, video));
    local.addEventListener('error', (e) => toast(e.detail, 10000));
    await local.start();
    state.duration = meta.duration;
    if (probe.audioNote) toast(probe.audioNote, 8000);
  } else {
    state.fileUrl = URL.createObjectURL(file);
    video.src = state.fileUrl;
    await once(video, 'loadedmetadata');
    state.duration = video.duration;
  }
  $('stat-file').textContent = `${file.name} · ${formatBytes(file.size)}`;
  if (state.peer?.isOpen) startStreaming();
  refreshOverlay();
  ui.render();
}

video.addEventListener('error', () => {
  if (state.role === 'host' && state.file) {
    toast("Your browser can't play this file's codec. Try an H.264/AAC MP4.", 8000);
  }
});

/** Can this browser play the file by itself? (Tried in a throwaway <video>.) */
async function playsHere(file) {
  const test = document.createElement('video');
  test.muted = true;
  const url = URL.createObjectURL(file);
  test.src = url;
  const ok = await Promise.race([
    once(test, 'loadedmetadata').then(() => test.videoWidth > 0),
    once(test, 'error').then(() => false),
    new Promise((r) => setTimeout(() => r(false), 6000)),
  ]);
  test.removeAttribute('src');
  test.load();
  URL.revokeObjectURL(url);
  return ok;
}

async function startStreaming() {
  const peer = state.peer;
  state.streamer?.close();
  state.streamer = null;
  if (state.nativeOnly) return startCompat('host');
  state.compatSender?.stop();
  state.compatSender = null;
  state.abr = null;
  renderQuality();
  const streamer = (state.streamer = new HostStreamer(state.file, peer, { adaptive: true }));
  streamer.onState = (abr) => {
    if (streamer !== state.streamer) return;
    state.abr = abr;
    renderQuality();
    peer.sendControl({ t: 'abr', state: abr });
  };
  // Even the lowest re-encode can't keep up on this device: fall back to live video.
  streamer.onTooSlow = () => {
    if (streamer === state.streamer) startCompat('slow');
  };
  try {
    const meta = await streamer.probe();
    if (peer.video.readyState !== 'open') await once(peer.video, 'open');
    if (streamer !== state.streamer) return;
    peer.video.send(JSON.stringify(meta));
  } catch (err) {
    toast(err.message, 10000);
  }
}

// ---------------------------------------------------------------- compatibility mode (live video)

/** Host: send the movie as live video, because the partner can't decode it or it isn't streamable. */
function startCompat(reason) {
  const peer = state.peer;
  if (!peer?.isOpen || !state.file) return;
  if (!canCapture(video)) {
    const msg = "Your partner's browser can't play this video, and this browser can't stream it live. Use Chrome or Edge, or convert the movie to H.264 MP4.";
    peer.sendControl({ t: 'compat-unavailable', reason: msg });
    toast(msg, 10000);
    return;
  }
  state.streamer?.close();
  state.streamer = null;
  state.compatSender?.stop();
  state.compatSender = new CompatSender(peer, video);
  state.compatSender.start({ duration: state.duration, name: state.file.name, size: state.file.size });
  $('stat-stream').textContent = 'Live (compatibility mode)';
  state.abr = null;
  renderQuality();
  toast(
    reason === 'guest'
      ? `${state.peerName || 'Your partner'}'s browser can't decode this video, so it's streamed live (compatibility mode).`
      : reason === 'slow'
        ? "This device can't convert the video fast enough, so it's streamed live instead (compatibility mode)."
        : 'This format is streamed live to your partner (compatibility mode).',
    7000
  );
}

/** Guest: the host is about to send the movie as a live track; we become a remote control. */
function enterCompat(msg) {
  state.compatPending = false;
  state.compat = { streamId: msg.streamId, stream: null };
  state.peer.compatStreamId = msg.streamId;
  state.duration = msg.duration;
  $('stat-file').textContent = `${msg.name} · ${formatBytes(msg.size)} · live (compatibility mode)`;
  setNowPlaying(msg.name);
  video.removeAttribute('src');
  state.sync?.setRemoteControl(true);
  state.peer.sendControl({ t: 'compat-ready' });
  refreshOverlay();
}

function exitCompat() {
  if (!state.compat) return;
  video.srcObject = null;
  state.compat = null;
  if (state.peer) state.peer.compatStreamId = null;
  state.sync?.setRemoteControl(false);
  refreshOverlay();
}

// ---------------------------------------------------------------- status card

function refreshOverlay(errorText) {
  const overlay = $('overlay');
  const show = (text, sub = '', { spin = false, pick = false, tap = false, invite = false } = {}) => {
    overlay.classList.remove('hidden');
    overlay.classList.toggle('dropzone', pick);
    $('overlay-text').textContent = text;
    $('overlay-sub').textContent = sub;
    $('spinner').hidden = !spin;
    $('drop-icon').hidden = !pick;
    $('pick-file').hidden = !pick;
    $('tap-play').hidden = !tap;
    $('invite').hidden = !invite;
    ui.setBusy(true);
  };
  const isHost = state.role === 'host';
  const s = state.sync;
  const connected = !!state.peer?.isOpen;
  ui.setHasMedia(isHost ? !!state.file : !!state.player?.meta || !!state.compat?.stream);

  if (errorText) return show(errorText);
  if (isHost && state.preparing != null) {
    return show(
      `Getting the movie ready… ${state.preparing}%`,
      'This phone can only read the video from start to end, so it’s copied into the browser once first.',
      { spin: true }
    );
  }
  if (isHost && !state.file) {
    const sub = connected
      ? 'Drop a video here or browse. It streams straight to your partner.'
      : 'Drop a video here or browse. It starts streaming when your partner joins.';
    return show('Pick tonight’s movie', sub, { pick: true });
  }
  if (!state.peer && state.resumeOnRejoin) {
    return show('Paused until your partner is back…', 'The movie resumes from here when they rejoin.', { spin: true });
  }
  if (!state.peer) {
    return show('Waiting for your partner…', `Share code ${state.code} or send them the invite link.`, {
      spin: true,
      invite: true,
    });
  }
  if (!connected) return show('Connecting…', 'Setting up a direct, encrypted link between you two.', { spin: true });
  if (!isHost && (state.compatPending || (state.compat && !state.compat.stream))) {
    return show(
      'Switching to compatibility mode…',
      "This browser can't decode the movie directly, so your partner will stream it live.",
      { spin: true }
    );
  }
  if (!isHost && !state.player?.meta && !state.compat) {
    return show('Waiting for your partner to pick a movie…', '', { spin: true });
  }
  if (s?.blocked) return show('Ready when you are', 'Your browser needs a tap before it can play.', { tap: true });
  // Buffering: only show the card if it lasts a moment, so brief hiccups don't flash it.
  const buffering = s?.intent && (s.localBuffering || s.peerBuffering);
  if (buffering) {
    state.bufferingSince ??= performance.now();
    const waited = performance.now() - state.bufferingSince;
    if (waited < BUFFER_CARD_DELAY_MS) {
      clearTimeout(state.bufferingTimer);
      state.bufferingTimer = setTimeout(() => refreshOverlay(), BUFFER_CARD_DELAY_MS - waited + 20);
    } else if (s.localBuffering) {
      const wait = Math.round(s.resumeAhead || 3);
      return show('Buffering…', `Loading from your partner’s device · resumes with ${wait} s ready.`, { spin: true });
    } else {
      return show(`Waiting for ${state.peerName || 'your partner'}…`, 'Their video is buffering.', { spin: true });
    }
  } else {
    state.bufferingSince = null;
  }
  overlay.classList.add('hidden');
  ui.setBusy(false);
}
const BUFFER_CARD_DELAY_MS = 900;

function onSyncState(st) {
  ui.setPlaying(st.intent);
  $('play').setAttribute('aria-label', st.intent ? 'Pause' : 'Play');
  const drift = st.drift != null ? ` · drift ${Math.round(st.drift * 1000)} ms` : '';
  $('stat-sync').textContent = `${st.rttMs} ms round trip${drift}`;
  refreshOverlay();
  updateWakeLock(st.intent);
}

$('tap-play').onclick = () => {
  if (state.sync) state.sync.blocked = false;
  video.play().catch(() => {});
  state.sync?.update();
  refreshOverlay();
};

function setPartner(name) {
  state.peerName = name;
  $('partner').classList.toggle('online', !!name);
  $('partner-name').textContent = name || 'Waiting…';
  $('partner-avatar').textContent = name ? name.trim()[0].toUpperCase() : '?';
  $('partner').title = name ? `${name} is here` : 'Your partner hasn’t joined yet';
}

function setLink(text, cls) {
  const el = $('link');
  el.hidden = !text;
  $('link-text').textContent = text || '';
  el.className = `pill link-pill ${cls || ''}`;
  el.title = text || '';
  $('stat-link').textContent = text || '—';
}

async function updateLinkInfo() {
  const info = await state.peer?.connectionInfo().catch(() => null);
  if (!info) return;
  const rtt = info.rttMs != null ? ` · ${info.rttMs} ms` : '';
  setLink(info.mode === 'relay' ? `Relayed${rtt}` : `Direct${rtt}`, info.mode);
}

setInterval(() => {
  if (state.peer?.isOpen) updateLinkInfo();
  // Throughput + partner buffer readout.
  const now = performance.now();
  const bytes = state.role === 'host' ? state.streamer?.bytesSent ?? 0 : state.player?.bytesReceived ?? 0;
  const rate = Math.max(0, bytes - state.lastBytes) / ((now - state.lastBytesAt) / 1000);
  state.lastBytes = bytes;
  state.lastBytesAt = now;
  const ahead = state.role === 'host' ? state.guestStatus?.ahead : state.player?.bufferedAhead();
  if (state.compatSender || state.compat) {
    $('stat-stream').textContent = 'Live video (compatibility mode)';
  } else if (state.peer?.isOpen && (state.streamer || state.player?.meta)) {
    const who = state.role === 'host' ? 'partner has' : 'buffered';
    $('stat-stream').textContent = `${formatMbps(rate * 8)} · ${who} ${ahead != null ? Math.round(ahead) + ' s' : '—'}`;
  } else {
    $('stat-stream').textContent = '—';
  }
  renderQuality();
}, 2000);

const formatMbps = (bps) => (bps == null ? '—' : bps >= 1e6 ? `${(bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1)} Mbps` : `${Math.round(bps / 1e3)} kbps`);

// ---------------------------------------------------------------- quality menu (auto quality)

const QUALITY_LABELS = { auto: 'Auto', original: 'Original', 1080: '1080p', 720: '720p', 480: '480p', 360: '360p' };

/** Stats line + quality menu from the host's auto-quality state (host: local, guest: via 'abr'). */
function renderQuality() {
  const abr = state.abr;
  const options = abr?.available?.length ? ['auto', ...abr.available] : [];
  $('quality-btn').hidden = options.length < 2;
  $('quality-badge').textContent = abr ? (abr.current === 'Original' ? 'HD' : abr.current) : '';
  $('stat-quality').textContent = abr
    ? `${abr.quality === 'auto' ? 'Auto · ' : ''}${abr.current}` +
      (abr.streamBps ? ` (${formatMbps(abr.streamBps)})` : '') +
      ` · link ≈ ${formatMbps(abr.linkBps)} · movie ${formatMbps(abr.movieBps)}`
    : '—';
  const menu = $('quality-pop');
  if (menu.hidden) return;
  menu.innerHTML = options
    .map((q) => {
      const active = abr.quality === q;
      const label = q === 'auto' ? `Auto <span class="muted">(${abr.current})</span>` : QUALITY_LABELS[q];
      return `<button class="q-opt${active ? ' active' : ''}" data-q="${q}">${label}</button>`;
    })
    .join('');
}

function setQualityOpen(open) {
  $('quality-pop').hidden = !open;
  ui.hold('quality', open);
  renderQuality();
}
$('quality-btn').onclick = (e) => {
  e.stopPropagation();
  setQualityOpen($('quality-pop').hidden);
};
$('quality-pop').addEventListener('click', (e) => {
  const q = e.target.closest('[data-q]')?.dataset.q;
  if (!q) return;
  if (state.role === 'host') state.streamer?.setQuality(q);
  else state.peer?.sendControl({ t: 'quality', value: q });
  setQualityOpen(false);
  toast(q === 'auto' ? 'Quality: Auto (adjusts to your connection)' : `Quality: ${QUALITY_LABELS[q]}`);
});

// ---------------------------------------------------------------- controls

$('play').onclick = () => {
  unlockMedia();
  state.sync?.toggle();
};

// Volume: two independent levels, the movie and the call (your partner's voice). Voice ducking
// still lowers the movie while your partner talks. Levels are remembered on this device; mutes
// are not, so nobody starts the next movie night wondering why there's no sound.
const VOLUME_KEY = 'duet:volume';
// iPhone/iPad ignore .volume (only the side buttons set it): there the rows only mute/unmute.
const canSetVolume = (() => {
  const a = document.createElement('audio');
  try {
    a.volume = 0.5;
  } catch {}
  return a.volume === 0.5;
})();
const volume = { movie: 1, call: 1 };
const lastLevel = { movie: 1, call: 1 };
try {
  const saved = JSON.parse(safeGet(localStorage, VOLUME_KEY) || '{}');
  for (const kind of ['movie', 'call']) if (saved[kind] > 0 && saved[kind] <= 1) volume[kind] = lastLevel[kind] = saved[kind];
} catch {}

function setLevel(kind, v) {
  v = Math.min(1, Math.max(0, Math.round(v * 100) / 100));
  volume[kind] = v;
  if (v > 0) lastLevel[kind] = v;
  if (kind === 'movie') voice.setBaseVolume(v);
  else voice.setCallVolume(v);
  $(`${kind}-vol`).value = v;
  $(`${kind}-vol-val`).textContent = v === 0 ? 'Muted' : canSetVolume ? `${Math.round(v * 100)}%` : 'On';
  $(`${kind}-row`).classList.toggle('off', v === 0);
  $(`${kind}-mute`).setAttribute('aria-label', `${v === 0 ? 'Unmute' : 'Mute'} ${kind === 'movie' ? 'movie' : 'call'}`);
  $('vol-btn').classList.toggle('muted-on', volume.movie === 0);
  safeSet(localStorage, VOLUME_KEY, JSON.stringify(lastLevel));
}
const toggleLevel = (kind) => setLevel(kind, volume[kind] === 0 ? lastLevel[kind] : 0);
for (const kind of ['movie', 'call']) {
  $(`${kind}-vol`).addEventListener('input', (e) => setLevel(kind, +e.target.value));
  $(`${kind}-mute`).onclick = () => toggleLevel(kind);
  setLevel(kind, volume[kind]);
}
if (!canSetVolume) {
  $('vol-pop').classList.add('no-volume');
  $('vol-note').hidden = false;
}

function setVolumeOpen(open) {
  $('vol-pop').hidden = !open;
  $('vol-btn').setAttribute('aria-expanded', String(open));
  ui.hold('volume', open);
}
$('vol-btn').onclick = (e) => {
  e.stopPropagation();
  setVolumeOpen($('vol-pop').hidden);
};

$('mic').onclick = async () => {
  try {
    const on = await voice.toggleMic();
    $('mic').classList.toggle('on', on);
    $('mic').setAttribute('aria-label', on ? 'Mute microphone' : 'Turn microphone on');
  } catch (err) {
    toast(err.name === 'NotAllowedError' ? 'Microphone permission denied.' : `Mic error: ${err.message}`, 5000);
  }
};
voice.addEventListener('partner-speaking', (e) => {
  $('partner').classList.toggle('speaking', e.detail);
  $('pip').classList.toggle('speaking', e.detail);
});

// Reactions popover
function setReactOpen(open) {
  $('react-pop').hidden = !open;
  ui.hold('popover', open);
}
$('react-btn').onclick = (e) => {
  e.stopPropagation();
  setReactOpen($('react-pop').hidden);
};
document.querySelectorAll('.react').forEach((btn) => {
  btn.onclick = (e) => {
    e.stopPropagation();
    const emoji = btn.dataset.emoji;
    floatReaction(emoji);
    state.peer?.sendControl({ t: 'react', emoji });
    ui.show();
  };
});

// Stats sheet
function setStatsOpen(open) {
  $('stats').hidden = !open;
  ui.hold('stats', open);
}
$('stats-btn').onclick = (e) => {
  e.stopPropagation();
  setStatsOpen($('stats').hidden);
};
$('stats-close').onclick = () => setStatsOpen(false);

// Close popovers when tapping elsewhere.
document.addEventListener('pointerdown', (e) => {
  if (!$('react-pop').hidden && !e.target.closest('.react-wrap')) setReactOpen(false);
  if (!$('stats').hidden && !e.target.closest('#stats, #stats-btn')) setStatsOpen(false);
  if (!$('quality-pop').hidden && !e.target.closest('.quality-wrap')) setQualityOpen(false);
  if (!$('vol-pop').hidden && !e.target.closest('.vol-wrap')) setVolumeOpen(false);
});

function floatReaction(emoji) {
  const el = document.createElement('span');
  el.textContent = emoji;
  el.style.left = `${10 + Math.random() * 75}%`;
  $('reactions').appendChild(el);
  setTimeout(() => el.remove(), 2700);
}

// ---------------------------------------------------------------- face-cam picture-in-picture

$('cam').onclick = async () => {
  try {
    await camera.toggle();
  } catch (err) {
    const msg =
      err.name === 'NotAllowedError'
        ? 'Camera permission denied.'
        : err.name === 'NotFoundError'
          ? 'No camera found on this device.'
          : `Camera error: ${err.message}`;
    toast(msg, 5000);
  }
};

camera.addEventListener('change', (e) => {
  const { self, partner } = e.detail;
  $('cam').classList.toggle('on', self);
  $('cam').setAttribute('aria-label', self ? 'Turn camera off' : 'Turn camera on');
  $('pip-self').hidden = !self;
  $('pip-partner').hidden = !partner;
  $('pip').hidden = !self && !partner;
  $('pip').classList.toggle('both', self && partner);
  $('pip-partner-name').textContent = state.peerName || '';
});

const pip = $('pip');
const savedCorner = safeGet(localStorage, 'duet:pip-corner');
if (/^corner-(tl|tr|bl|br)$/.test(savedCorner || '')) pip.className = `pip ${savedCorner}`;

// Drag the bubbles anywhere; on release they snap to the nearest corner. A tap toggles size.
pip.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  const start = { x: e.clientX, y: e.clientY };
  const rect = pip.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  let moved = false;
  pip.setPointerCapture(e.pointerId);

  const onMove = (ev) => {
    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    if (!moved && Math.hypot(dx, dy) < 6) return;
    moved = true;
    pip.classList.add('dragging');
    pip.style.transform = `translate(${dx}px, ${dy}px)`;
  };
  const onUp = (ev) => {
    pip.removeEventListener('pointermove', onMove);
    pip.removeEventListener('pointerup', onUp);
    pip.removeEventListener('pointercancel', onUp);
    pip.classList.remove('dragging');
    pip.style.transform = '';
    if (!moved) return void pip.classList.toggle('large');
    const cx = rect.left + rect.width / 2 + (ev.clientX - start.x) - stageRect.left;
    const cy = rect.top + rect.height / 2 + (ev.clientY - start.y) - stageRect.top;
    const corner = `corner-${cy < stageRect.height / 2 ? 't' : 'b'}${cx < stageRect.width / 2 ? 'l' : 'r'}`;
    pip.classList.remove('corner-tl', 'corner-tr', 'corner-bl', 'corner-br');
    pip.classList.add(corner);
    safeSet(localStorage, 'duet:pip-corner', corner);
  };
  pip.addEventListener('pointermove', onMove);
  pip.addEventListener('pointerup', onUp);
  pip.addEventListener('pointercancel', onUp);
});

// ---------------------------------------------------------------- fullscreen & keyboard

$('fullscreen').onclick = toggleFullscreen;
function toggleFullscreen() {
  if (document.fullscreenElement) return document.exitFullscreen();
  if (stage.requestFullscreen) {
    stage
      .requestFullscreen({ navigationUI: 'hide' })
      .then(() => {
        // Phones: turn sideways for the movie.
        if (matchMedia('(pointer: coarse)').matches) screen.orientation?.lock?.('landscape').catch(() => {});
      })
      .catch(() => {});
  } else if (video.webkitEnterFullscreen) {
    video.webkitEnterFullscreen(); // iPhone
  }
}
document.addEventListener('fullscreenchange', () => {
  const fs = !!document.fullscreenElement;
  stage.classList.toggle('is-fullscreen', fs);
  $('fullscreen').setAttribute('aria-label', fs ? 'Exit fullscreen' : 'Fullscreen');
  if (!fs) screen.orientation?.unlock?.();
});

document.addEventListener('keydown', (e) => {
  if ($('room').hidden || e.target.tagName === 'INPUT') return;
  const seekBy = (delta) => {
    state.sync?.seek(Math.max(0, video.currentTime + delta));
    ui.flashRipple(delta < 0 ? 'left' : 'right', Math.abs(delta));
  };
  if (e.code === 'Space' || e.key === 'k') {
    e.preventDefault();
    state.sync?.toggle();
  } else if (e.key === 'ArrowRight') seekBy(5);
  else if (e.key === 'ArrowLeft') seekBy(-5);
  else if (e.key === 'l') seekBy(10);
  else if (e.key === 'j') seekBy(-10);
  else if (e.key === 'f') toggleFullscreen();
  else if (e.key === 'm') $('mic').click();
  else if (e.key === 'c') $('cam').click();
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    setLevel('movie', volume.movie + (e.key === 'ArrowUp' ? 0.1 : -0.1));
    toast(`Movie volume ${Math.round(volume.movie * 100)}%`, 1200);
  } else if (e.key === 'Escape') {
    setReactOpen(false);
    setStatsOpen(false);
    setVolumeOpen(false);
  }
});

async function copyInvite() {
  const url = `${location.origin}/?room=${state.code}`;
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    navigator.share({ title: 'Watch with me on Duet Watch', text: `Room code ${state.code}`, url }).catch(() => {});
  } else {
    await navigator.clipboard?.writeText(url).catch(() => {});
    toast('Invite link copied');
  }
}
$('copy-code').onclick = copyInvite;
$('invite').onclick = copyInvite;

// ---------------------------------------------------------------- helpers

// Mobile browsers only allow sound after a tap; use the Create/Join tap to start the audio engine.
// (Don't play/pause the <video> here: that late 'pause' event would be broadcast as a real pause.
// If a browser still blocks a remote "play", the overlay offers a tap-to-start button.)
let unlocked = false;
function unlockMedia() {
  if (unlocked) return;
  unlocked = true;
  voice.ensureAudioContext();
}

let wakeLock = null;
async function updateWakeLock(playing) {
  try {
    if (playing && !wakeLock && navigator.wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!playing && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {}
}

function toast(msg, ms = 2500) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), ms);
}

function once(target, event) {
  return new Promise((resolve) => target.addEventListener(event, resolve, { once: true }));
}

function formatBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

function saveSession(s) {
  safeSet(sessionStorage, 'duet:session', JSON.stringify(s));
}
function loadSession() {
  try {
    return JSON.parse(safeGet(sessionStorage, 'duet:session'));
  } catch {
    return null;
  }
}
function clearSession() {
  try {
    sessionStorage.removeItem('duet:session');
  } catch {}
}
function safeGet(store, key) {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(store, key, value) {
  try {
    store.setItem(key, value);
  } catch {}
}
