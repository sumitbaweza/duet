// Signaling + room coordination server.
// It only relays small JSON messages (room PINs, SDP, ICE). Movie bytes never pass through here.
import express from 'express';
import { createServer } from 'node:http';
import { randomInt, randomBytes, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Server } from 'socket.io';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || undefined; // e.g. 127.0.0.1 behind a reverse proxy; default = all interfaces
const TURN_CREDENTIAL_TTL_S = 6 * 60 * 60;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // rooms live at most 6 hours
const EMPTY_ROOM_GRACE_MS = 10 * 60 * 1000; // keep an empty room 10 min so a refresh can rejoin
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
const MAX_FAILED_JOINS_PER_MIN = 10;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { maxHttpBufferSize: 64 * 1024 });

app.disable('x-powered-by');
app.use(express.static(path.join(ROOT, 'public')));
app.use('/vendor/mp4box', express.static(path.join(ROOT, 'node_modules/mp4box/dist')));
// Local testing only: lets automated tests load sample clips without a file picker.
if (process.env.DUET_TEST_MEDIA === '1') app.use('/test-media', express.static(path.join(ROOT, 'test-media')));
app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

// ICE servers. STUN is free; TURN is needed when either side is behind a strict NAT
// (mobile carriers often are). Configure via env so credentials never live in the client code.
app.get('/api/ice-servers', async (_req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  try {
    if (process.env.METERED_DOMAIN && process.env.METERED_API_KEY) {
      const url = `https://${process.env.METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${process.env.METERED_API_KEY}`;
      const r = await fetch(url);
      if (r.ok) iceServers.push(...(await r.json()));
    } else if (process.env.TURN_URLS) {
      const urls = process.env.TURN_URLS.split(',').map((s) => s.trim());
      if (process.env.TURN_SECRET) {
        // Your own coturn with `use-auth-secret`: hand out a password that expires in 6 hours
        // (coturn "TURN REST API" scheme), so a leaked credential can't be reused for long.
        const username = `${Math.floor(Date.now() / 1000) + TURN_CREDENTIAL_TTL_S}:duet`;
        const credential = createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
        iceServers.push({ urls, username, credential });
      } else {
        iceServers.push({ urls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
      }
    }
  } catch (err) {
    console.warn('TURN credential fetch failed:', err.message);
  }
  res.set('Cache-Control', 'no-store').json({ iceServers });
});

/**
 * In-memory room store. For multiple server instances, move this to Redis
 * (key = room code, value = this object, EXPIRE = 6h) and add the socket.io Redis adapter.
 * @type {Map<string, {code: string, createdAt: number, emptySince: number|null,
 *   members: {host: Member, guest: Member|null}}>}
 * @typedef {{token: string, socketId: string|null, name: string}} Member
 */
const rooms = new Map();

function newCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
}

const newToken = () => randomBytes(16).toString('hex');
const cleanName = (n) => String(n ?? '').trim().slice(0, 24) || 'Friend';

function otherMember(room, role) {
  return role === 'host' ? room.members.guest : room.members.host;
}

function publicState(room) {
  const { host, guest } = room.members;
  return {
    code: room.code,
    host: host && { name: host.name, online: !!host.socketId },
    guest: guest && { name: guest.name, online: !!guest.socketId },
  };
}

function attach(socket, room, role) {
  const member = room.members[role];
  if (member.socketId && member.socketId !== socket.id) {
    // Same person opened a second tab / reconnected: kick the stale socket.
    io.sockets.sockets.get(member.socketId)?.disconnect(true);
  }
  member.socketId = socket.id;
  room.emptySince = null;
  socket.data.room = room.code;
  socket.data.role = role;
  socket.join(room.code);
  const other = otherMember(room, role);
  if (other?.socketId) io.to(other.socketId).emit('peer-joined', { name: member.name });
  return {
    ok: true,
    role,
    token: member.token,
    peerOnline: !!other?.socketId,
    peerName: other?.name ?? null,
    state: publicState(room),
  };
}

io.on('connection', (socket) => {
  let failedJoins = [];

  socket.on('create-room', (payload, ack) => {
    if (typeof ack !== 'function') return;
    leaveCurrentRoom(socket);
    const room = {
      code: newCode(),
      createdAt: Date.now(),
      emptySince: null,
      members: { host: { token: newToken(), socketId: null, name: cleanName(payload?.name) }, guest: null },
    };
    rooms.set(room.code, room);
    ack(attach(socket, room, 'host'));
  });

  socket.on('join-room', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const now = Date.now();
    failedJoins = failedJoins.filter((t) => now - t < 60_000);
    if (failedJoins.length >= MAX_FAILED_JOINS_PER_MIN) {
      return ack({ ok: false, error: 'Too many attempts. Wait a minute and try again.' });
    }
    const code = String(payload?.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const room = rooms.get(code);
    if (!room) {
      failedJoins.push(now);
      return ack({ ok: false, error: 'Room not found. Check the code.' });
    }
    const token = payload?.token;
    // Rejoin with a saved token (page refresh, network drop).
    for (const role of ['host', 'guest']) {
      if (token && room.members[role]?.token === token) {
        if (socket.data.room !== code) leaveCurrentRoom(socket);
        return ack(attach(socket, room, role));
      }
    }
    if (room.members.guest) return ack({ ok: false, error: 'This room already has two people.' });
    leaveCurrentRoom(socket);
    room.members.guest = { token: newToken(), socketId: null, name: cleanName(payload?.name) };
    ack(attach(socket, room, 'guest'));
  });

  // Relay SDP descriptions and ICE candidates to the other person in the room.
  socket.on('signal', (data) => {
    const room = rooms.get(socket.data.room);
    if (!room || !data || typeof data !== 'object') return;
    const other = otherMember(room, socket.data.role);
    if (other?.socketId) io.to(other.socketId).emit('signal', data);
  });

  socket.on('leave-room', () => leaveCurrentRoom(socket, true));
  socket.on('disconnect', () => leaveCurrentRoom(socket));
});

function leaveCurrentRoom(socket, permanent = false) {
  const room = rooms.get(socket.data.room);
  const role = socket.data.role;
  socket.data.room = null;
  socket.data.role = null;
  if (!room) return;
  socket.leave(room.code);
  const member = room.members[role];
  if (!member || member.socketId !== socket.id) return;
  member.socketId = null;
  const other = otherMember(room, role);
  if (other?.socketId) io.to(other.socketId).emit('peer-left', { permanent });
  if (permanent) {
    if (role === 'host') {
      if (other?.socketId) io.to(other.socketId).emit('room-closed');
      rooms.delete(room.code);
      return;
    }
    room.members.guest = null;
  }
  if (!room.members.host.socketId && !room.members.guest?.socketId) room.emptySince = Date.now();
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const expired = now - room.createdAt > ROOM_TTL_MS;
    const abandoned = room.emptySince && now - room.emptySince > EMPTY_ROOM_GRACE_MS;
    if (expired || abandoned) {
      io.to(code).emit('room-closed');
      rooms.delete(code);
    }
  }
}, 60_000).unref();

httpServer.listen(PORT, HOST, () => {
  console.log(`Duet signaling server on http://${HOST || 'localhost'}:${PORT}`);
});
