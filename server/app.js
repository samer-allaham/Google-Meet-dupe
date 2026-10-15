import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { RoomManager, RoomError, normalizeCode, CODE_PATTERN } from './rooms.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** Changes whenever a client file changes, so open tabs can tell they are running old code. */
export function clientVersion(dir = PUBLIC_DIR) {
  let latest = 0;
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) latest = Math.max(latest, fs.statSync(path.join(entry.parentPath, entry.name)).mtimeMs);
  }
  return String(Math.floor(latest));
}

export const REACTIONS = ['👍', '❤️', '😂', '😮', '👏', '🎉'];

function defaultIceServers() {
  if (process.env.ICE_SERVERS) {
    try {
      return JSON.parse(process.env.ICE_SERVERS);
    } catch {
      console.warn('ICE_SERVERS is not valid JSON; falling back to public STUN');
    }
  }
  return [{ urls: 'stun:stun.l.google.com:19302' }];
}

/**
 * Builds the HTTP + Socket.IO server without listening, so tests can
 * start it on an ephemeral port.
 */
export function createMeetServer({ rooms = new RoomManager(), iceServers = defaultIceServers() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.get('/api/config', (_req, res) => res.json({ iceServers, version: clientVersion(), debug: Boolean(process.env.MEETUP_DEBUG) }));

  app.post('/api/meetings', (_req, res) => {
    res.status(201).json({ code: rooms.createRoom() });
  });

  app.get('/api/meetings/:code', (req, res) => {
    const code = normalizeCode(req.params.code);
    if (!code) return res.status(400).json({ error: 'invalid_code' });
    if (!rooms.hasRoom(code)) return res.status(404).json({ error: 'not_found' });
    res.json({ code, participants: rooms.participants(code).length });
  });

  app.use(express.static(PUBLIC_DIR));

  // Meet-style deep links: /abc-defg-hij serves the SPA.
  app.get('/:code', (req, res, next) => {
    if (!CODE_PATTERN.test(req.params.code)) return next();
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  const httpServer = http.createServer(app);
  const io = new Server(httpServer, { maxHttpBufferSize: 64 * 1024 });

  io.on('connection', (socket) => {
    const ack = (cb, payload) => (typeof cb === 'function' ? cb(payload) : undefined);

    function leaveCurrent() {
      const code = socket.data.room;
      if (!code) return;
      socket.data.room = null;
      socket.leave(code);
      if (rooms.leave(code, socket.id)) socket.to(code).emit('peer-left', { id: socket.id });
    }

    socket.on('join', (payload, cb) => {
      try {
        const code = normalizeCode(payload?.code);
        if (!code) throw new RoomError('invalid_code', 'That meeting code is not valid.');
        if (socket.data.room) leaveCurrent();
        const self = rooms.join(code, socket.id, payload);
        const others = rooms.participants(code).filter((p) => p.id !== socket.id);
        socket.data.room = code;
        socket.join(code);
        socket.to(code).emit('peer-joined', self);
        if (process.env.MEETUP_DEBUG) {
          const ua = socket.handshake.headers['user-agent'] ?? '';
          console.log(`[join] ${self.name} -> ${code} mic=${self.audio} cam=${self.video} from ${socket.handshake.address} ${ua.match(/(Edg|OPR|Firefox|Chrome|Safari)\/[\d.]+/g)?.join(' ') ?? ua}`);
        }
        ack(cb, { ok: true, self, participants: others, chat: rooms.getRoom(code).chat });
      } catch (err) {
        if (!(err instanceof RoomError)) console.error(err);
        ack(cb, { ok: false, error: err.code ?? 'server_error', message: err.message });
      }
    });

    // WebRTC offer/answer/ICE relay. Only allowed between members of the same room.
    socket.on('signal', (payload) => {
      const code = socket.data.room;
      const to = payload?.to;
      if (!code || typeof to !== 'string' || to === socket.id) return;
      if (!rooms.isMember(code, to)) return;
      io.to(to).emit('signal', { from: socket.id, data: payload.data });
    });

    socket.on('state', (patch) => {
      const code = socket.data.room;
      if (!code) return;
      const updated = rooms.updateState(code, socket.id, patch);
      if (updated) socket.to(code).emit('peer-state', updated);
    });

    socket.on('chat', (text, cb) => {
      const code = socket.data.room;
      const msg = code ? rooms.addMessage(code, socket.id, text) : null;
      if (!msg) return ack(cb, { ok: false });
      io.to(code).emit('chat', msg);
      ack(cb, { ok: true, message: msg });
    });

    socket.on('diag', (report) => {
      if (!process.env.MEETUP_DEBUG || !socket.data.room) return;
      const me = rooms.getRoom(socket.data.room)?.participants.get(socket.id);
      console.log(`[diag] ${new Date().toISOString().slice(11, 19)} ${me?.name ?? socket.id} ${JSON.stringify(report).slice(0, 4000)}`);
    });

    socket.on('reaction', (emoji) => {
      const code = socket.data.room;
      if (!code || !REACTIONS.includes(emoji)) return;
      io.to(code).emit('reaction', { from: socket.id, emoji });
    });

    socket.on('leave', (cb) => {
      leaveCurrent();
      ack(cb, { ok: true });
    });

    socket.on('disconnect', leaveCurrent);
  });

  return { app, httpServer, io, rooms };
}
