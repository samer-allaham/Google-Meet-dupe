import { randomInt, randomUUID } from 'node:crypto';

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
export const CODE_PATTERN = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

export const LIMITS = Object.freeze({
  maxParticipants: 8, // full-mesh WebRTC degrades quickly beyond this
  maxNameLength: 40,
  maxMessageLength: 1000,
  maxChatHistory: 200,
});

export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function randomLetters(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += LETTERS[randomInt(LETTERS.length)];
  return s;
}

/** Meet-style code, e.g. "abc-defg-hij". */
export function generateCode() {
  return `${randomLetters(3)}-${randomLetters(4)}-${randomLetters(3)}`;
}

export function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  // Accept a pasted meeting URL.
  const fromUrl = s.match(/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?(?:[?#].*)?$/);
  if (fromUrl) s = fromUrl[1];
  // Accept "abcdefghij" without dashes.
  if (/^[a-z]{10}$/.test(s)) s = `${s.slice(0, 3)}-${s.slice(3, 7)}-${s.slice(7)}`;
  return CODE_PATTERN.test(s) ? s : null;
}

export function sanitizeName(name) {
  if (typeof name !== 'string') return null;
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.slice(0, LIMITS.maxNameLength);
}

export function sanitizeMessage(text) {
  if (typeof text !== 'string') return null;
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (!clean) return null;
  return clean.slice(0, LIMITS.maxMessageLength);
}

const MEDIA_FLAGS = ['audio', 'video', 'screen', 'hand'];

export class RoomManager {
  /**
   * @param {{ emptyTtlMs?: number, now?: () => number }} [opts]
   *   emptyTtlMs: how long an empty room survives before being deleted.
   */
  constructor({ emptyTtlMs = 10 * 60 * 1000, now = Date.now } = {}) {
    this.rooms = new Map();
    this.emptyTtlMs = emptyTtlMs;
    this.now = now;
    this.timers = new Map();
  }

  createRoom() {
    let code;
    do code = generateCode();
    while (this.rooms.has(code));
    this.rooms.set(code, {
      code,
      createdAt: this.now(),
      participants: new Map(),
      chat: [],
    });
    this.#scheduleCleanup(code);
    return code;
  }

  hasRoom(code) {
    return this.rooms.has(code);
  }

  getRoom(code) {
    return this.rooms.get(code) ?? null;
  }

  join(code, id, { name, audio = true, video = true } = {}) {
    const room = this.rooms.get(code);
    if (!room) throw new RoomError('not_found', 'This meeting does not exist or has ended.');
    if (room.participants.has(id)) throw new RoomError('already_joined', 'Already in this meeting.');
    if (room.participants.size >= LIMITS.maxParticipants) {
      throw new RoomError('full', `This meeting is full (max ${LIMITS.maxParticipants}).`);
    }
    const cleanName = sanitizeName(name);
    if (!cleanName) throw new RoomError('invalid_name', 'Please enter your name.');

    const participant = {
      id,
      name: cleanName,
      audio: Boolean(audio),
      video: Boolean(video),
      screen: false,
      hand: false,
      joinedAt: this.now(),
    };
    room.participants.set(id, participant);
    this.#cancelCleanup(code);
    return participant;
  }

  leave(code, id) {
    const room = this.rooms.get(code);
    if (!room) return null;
    const p = room.participants.get(id) ?? null;
    room.participants.delete(id);
    if (room.participants.size === 0) this.#scheduleCleanup(code);
    return p;
  }

  updateState(code, id, patch) {
    const p = this.rooms.get(code)?.participants.get(id);
    if (!p || !patch || typeof patch !== 'object') return null;
    const changed = {};
    for (const key of MEDIA_FLAGS) {
      if (typeof patch[key] === 'boolean' && p[key] !== patch[key]) {
        p[key] = patch[key];
        changed[key] = patch[key];
      }
    }
    return Object.keys(changed).length ? { ...p } : null;
  }

  addMessage(code, id, text) {
    const room = this.rooms.get(code);
    const p = room?.participants.get(id);
    if (!p) return null;
    const clean = sanitizeMessage(text);
    if (!clean) return null;
    const msg = { id: randomUUID(), from: id, name: p.name, text: clean, at: this.now() };
    room.chat.push(msg);
    if (room.chat.length > LIMITS.maxChatHistory) room.chat.shift();
    return msg;
  }

  participants(code) {
    const room = this.rooms.get(code);
    return room ? [...room.participants.values()].map((p) => ({ ...p })) : [];
  }

  isMember(code, id) {
    return Boolean(this.rooms.get(code)?.participants.has(id));
  }

  dispose() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  #scheduleCleanup(code) {
    this.#cancelCleanup(code);
    const t = setTimeout(() => {
      this.timers.delete(code);
      const room = this.rooms.get(code);
      if (room && room.participants.size === 0) this.rooms.delete(code);
    }, this.emptyTtlMs);
    t.unref?.();
    this.timers.set(code, t);
  }

  #cancelCleanup(code) {
    const t = this.timers.get(code);
    if (t) {
      clearTimeout(t);
      this.timers.delete(code);
    }
  }
}
