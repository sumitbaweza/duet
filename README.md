# Duet — watch movies together, peer-to-peer

Two people, one movie, perfectly in sync. The host picks a video file on their device and it streams
**directly** to their partner's browser over an encrypted WebRTC DataChannel. The server only handles
room codes and connection setup. It never sees a single video byte.

## Run it

```bash
npm install
npm start            # http://localhost:3000
```

Open it in two browser windows: **Create a room** in one, enter the 6-character code in the other.

**Testing with a phone:** browsers only allow the microphone and some media APIs over HTTPS, so expose
your laptop with a tunnel instead of using your LAN IP:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

## How it works

```
Host browser                         Server (Node + Socket.io)              Guest browser
─────────────                        ─────────────────────────              ─────────────
File → mp4box.js (remux to fMP4)     room PIN, SDP/ICE relay only           MSE SourceBuffers ← fMP4
     → 64 KB chunks ───────── RTCDataChannel "video" (P2P, DTLS) ─────────→ reassemble → append
play/pause/seek/heartbeat ─── RTCDataChannel "control" ───────────────────→ sync engine
mic (Opus, echo-cancelled) ── RTP audio track ────────────────────────────→ <audio>, ducks movie
```

| File | Role |
|---|---|
| `server/index.js` | Rooms (6-char codes, 6 h TTL, rejoin tokens, brute-force limit), signaling relay, `/api/ice-servers` |
| `public/js/peer.js` | RTCPeerConnection with "perfect negotiation" and two pre-negotiated DataChannels |
| `public/js/host-streamer.js` | Reads the file, remuxes it to fragmented MP4 with mp4box.js, sends with backpressure, seeks on demand |
| `public/js/fmp4-index.js` | Indexes files that are *already* fragmented MP4 (many downloads/recordings) so they can be seeked and streamed as-is |
| `public/js/guest-player.js` | Reassembles segments into MSE (ManagedMediaSource on iPhone), evicts watched video, asks the host for missing ranges |
| `public/js/sync.js` | Shared play/pause/seek, host heartbeat, drift correction (0.95×–1.05× nudges, hard seek past 1 s), "wait for partner's buffer" |
| `public/js/voice.js` | Push-to-enable mic, echo cancellation, auto-ducks the movie while your partner talks |
| `public/js/camera.js` | Optional face cam (320×240, ≤300 kbps so it never starves the movie), shown as picture-in-picture bubbles you can drag to any corner and tap to resize |
| `public/js/player-ui.js` | Player chrome: 3 s auto-hide, tap / double-tap gestures with ±5 s ripple, scrub timeline with time preview |
| `public/js/main.js` | UI and lifecycle (reconnects, refresh-resume, reactions, wake lock, keyboard shortcuts) |

**Controls:** the top bar and controls appear on any mouse move or tap and fade after 3 s of stillness.
Double-tap (or double-click) the left/right side to jump −5 s/+5 s, and keep tapping for more. On phones a single tap
shows or hides the controls; on desktop a click plays or pauses and double-clicking the middle goes fullscreen.
Host can drag a movie file onto the player.

Keyboard: `Space`/`K` play/pause · `←`/`→` ±5 s · `J`/`L` ±10 s · `F` fullscreen · `M` mic · `C` camera · `Esc` close menus.
Add `?debug` to the URL for signaling logs and `window.duet` state.

## Changes from the original blueprint

1. **Two DataChannels, not one, and sync over WebRTC instead of WebSocket.** Play/pause goes on its own
   `control` channel so it never waits behind a 2 MB video segment, and it travels peer-to-peer, which is faster
   than a round trip through the server. The WebSocket is used only for setup.
2. **Pull-on-seek.** The guest keeps ~20 s behind and up to ~90 s ahead in RAM. When someone jumps
   outside that, the guest asks the host for that point and the host's mp4box seeks to the nearest keyframe.
   You can scrub anywhere in a two-hour movie without sending the whole file.
3. **No Redis/Nginx/cluster yet.** One small Node process handles thousands of rooms because it only
   relays a few KB per session. The room store is shaped so it can move to Redis later (see the comment in
   `server/index.js`).
4. **ManagedMediaSource** is required on iPhone (iOS 17.1+). Plain MSE doesn't exist on iPhone Safari.

## Known limits and recommended next steps

- **MKV is not supported yet.** mp4box only reads MP4/MOV. Most MKVs hold H.264 + AAC and convert
  instantly without re-encoding: `ffmpeg -i movie.mkv -c copy movie.mp4`. Next step: do this in-browser
  with ffmpeg.wasm.
- **Codecs:** the guest's browser must decode the video codec. H.264 + AAC works everywhere. HEVC/H.265
  fails on many Android/Firefox browsers, and AC-3/DTS audio fails in Chrome. When audio can't be decoded,
  the app plays video without sound and shows a warning. Next step: transcode the audio to AAC with
  ffmpeg.wasm or WebCodecs.
- **TURN server for production.** About 10–20% of connections (mobile carriers, corporate Wi-Fi) can't
  connect directly. Set `METERED_DOMAIN` + `METERED_API_KEY`, or `TURN_URLS`/`TURN_USERNAME`/`TURN_CREDENTIAL`.
  Relayed traffic is still end-to-end encrypted, but it costs TURN bandwidth: roughly 1.5–4 GB per movie.
  The header shows **Relayed (TURN)** when this happens.
- **Host refresh** loses the chosen file, because browsers can't keep `File` objects. The host just picks it again.
  Chrome's File System Access API could remember it.
- **Ideas:** front/back camera flip on phones, text chat, subtitles (.srt → WebVTT
  track sent over `control`), "skip intro" sync, and a host-side quality fallback using `captureStream()` for
  files the guest can't decode.

## Deploy

Any Node 20+ host with WebSocket support works, such as Render, Railway, Fly.io or a VPS. HTTPS is
required. Set `PORT` if needed, plus the TURN variables above.
