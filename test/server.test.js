import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { createMeetServer } from '../server/app.js';
import { RoomManager, LIMITS } from '../server/rooms.js';

let server;
let base;
const clients = [];

before(async () => {
  server = createMeetServer({ rooms: new RoomManager(), iceServers: [{ urls: 'stun:example.test:3478' }] });
  await new Promise((r) => server.httpServer.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.httpServer.address().port}`;
});

after(async () => {
  server.rooms.dispose();
  server.io.close();
  await new Promise((r) => server.httpServer.close(r));
});

afterEach(() => {
  for (const c of clients.splice(0)) c.disconnect();
});

function connect() {
  const c = ioClient(base, { transports: ['websocket'], forceNew: true, reconnection: false });
  clients.push(c);
  return new Promise((resolve, reject) => {
    c.once('connect', () => resolve(c));
    c.once('connect_error', reject);
  });
}

const emit = (c, ev, ...args) => new Promise((resolve) => c.emit(ev, ...args, resolve));

function next(c, ev, ms = 1000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for "${ev}"`)), ms);
    c.once(ev, (data) => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

/** Resolves true if the event does NOT arrive within ms. */
function silent(c, ev, ms = 150) {
  return new Promise((resolve) => {
    const handler = () => resolve(false);
    c.once(ev, handler);
    setTimeout(() => {
      c.off(ev, handler);
      resolve(true);
    }, ms);
  });
}

async function newMeeting() {
  const res = await fetch(`${base}/api/meetings`, { method: 'POST' });
  assert.equal(res.status, 201);
  return (await res.json()).code;
}

async function joined(code, name, extra = {}) {
  const c = await connect();
  const res = await emit(c, 'join', { code, name, ...extra });
  assert.equal(res.ok, true, res.message);
  return { c, res };
}

describe('HTTP API', () => {
  test('health check', async () => {
    const res = await fetch(`${base}/healthz`);
    assert.deepEqual(await res.json(), { ok: true });
  });

  test('config exposes ICE servers', async () => {
    const body = await (await fetch(`${base}/api/config`)).json();
    assert.deepEqual(body.iceServers, [{ urls: 'stun:example.test:3478' }]);
    assert.match(body.version, /^\d+$/);
  });

  test('create and look up a meeting', async () => {
    const code = await newMeeting();
    assert.match(code, /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
    const res = await fetch(`${base}/api/meetings/${code}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { code, participants: 0 });
  });

  test('lookup normalizes codes and reports participant count', async () => {
    const code = await newMeeting();
    await joined(code, 'Ann');
    const res = await fetch(`${base}/api/meetings/${code.replaceAll('-', '').toUpperCase()}`);
    assert.deepEqual(await res.json(), { code, participants: 1 });
  });

  test('lookup errors', async () => {
    assert.equal((await fetch(`${base}/api/meetings/not-valid`)).status, 400);
    assert.equal((await fetch(`${base}/api/meetings/zzz-zzzz-zzz`)).status, 404);
  });

  test('serves the app at / and at meeting deep links', async () => {
    for (const path of ['/', '/abc-defg-hij']) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /<title>Meetup/);
    }
    assert.equal((await fetch(`${base}/not-a-code`)).status, 404);
    assert.equal((await fetch(`${base}/js/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/socket.io/socket.io.js`)).status, 200);
  });
});

describe('socket: joining', () => {
  test('first joiner sees an empty room; later joiner sees existing participants', async () => {
    const code = await newMeeting();
    const { c: a, res: ra } = await joined(code, 'Alice', { audio: false });
    assert.equal(ra.self.id, a.id);
    assert.equal(ra.self.audio, false);
    assert.deepEqual(ra.participants, []);

    const announced = next(a, 'peer-joined');
    const { c: b, res: rb } = await joined(code, 'Bob');
    assert.deepEqual(rb.participants.map((p) => [p.id, p.name, p.audio]), [[a.id, 'Alice', false]]);
    const p = await announced;
    assert.equal(p.id, b.id);
    assert.equal(p.name, 'Bob');
  });

  test('rejects bad codes, unknown meetings and empty names', async () => {
    const c = await connect();
    assert.equal((await emit(c, 'join', { code: 'nope', name: 'X' })).error, 'invalid_code');
    assert.equal((await emit(c, 'join', { code: 'zzz-zzzz-zzz', name: 'X' })).error, 'not_found');
    const code = await newMeeting();
    assert.equal((await emit(c, 'join', { code, name: '  ' })).error, 'invalid_name');
    assert.equal((await emit(c, 'join', null)).error, 'invalid_code');
  });

  test('rejects joining a full meeting', async () => {
    const code = await newMeeting();
    for (let i = 0; i < LIMITS.maxParticipants; i++) await joined(code, `P${i}`);
    const extra = await connect();
    const res = await emit(extra, 'join', { code, name: 'Late' });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'full');
  });

  test('switching rooms leaves the previous one', async () => {
    const one = await newMeeting();
    const two = await newMeeting();
    const { c: watcher } = await joined(one, 'Watcher');
    const { c: mover } = await joined(one, 'Mover');
    const left = next(watcher, 'peer-left');
    assert.equal((await emit(mover, 'join', { code: two, name: 'Mover' })).ok, true);
    assert.deepEqual(await left, { id: mover.id });
    assert.equal(server.rooms.participants(one).length, 1);
    assert.equal(server.rooms.participants(two).length, 1);
  });

  test('chat history is delivered to late joiners', async () => {
    const code = await newMeeting();
    const { c: a } = await joined(code, 'Alice');
    await emit(a, 'chat', 'first!');
    const { res } = await joined(code, 'Bob');
    assert.deepEqual(res.chat.map((m) => [m.name, m.text]), [['Alice', 'first!']]);
  });
});

describe('socket: signaling relay', () => {
  test('relays signals only to the addressed peer, tagged with the sender', async () => {
    const code = await newMeeting();
    const { c: a } = await joined(code, 'A');
    const { c: b } = await joined(code, 'B');
    const { c: third } = await joined(code, 'C');

    const got = next(b, 'signal');
    const thirdSilent = silent(third, 'signal');
    a.emit('signal', { to: b.id, data: { description: { type: 'offer', sdp: 'v=0' } } });
    assert.deepEqual(await got, { from: a.id, data: { description: { type: 'offer', sdp: 'v=0' } } });
    assert.equal(await thirdSilent, true);
  });

  test('refuses to relay across rooms, to self, or when not joined', async () => {
    const r1 = await newMeeting();
    const r2 = await newMeeting();
    const { c: a } = await joined(r1, 'A');
    const { c: outsider } = await joined(r2, 'Outsider');
    const lurker = await connect();

    const quiet = silent(a, 'signal', 200);
    outsider.emit('signal', { to: a.id, data: { x: 1 } });
    lurker.emit('signal', { to: a.id, data: { x: 2 } });
    a.emit('signal', { to: a.id, data: { x: 3 } });
    a.emit('signal', { to: 12345, data: {} });
    a.emit('signal', null);
    assert.equal(await quiet, true);
  });
});

describe('socket: state, chat, reactions', () => {
  test('state changes are broadcast to others only', async () => {
    const code = await newMeeting();
    const { c: a } = await joined(code, 'A');
    const { c: b } = await joined(code, 'B');

    const update = next(b, 'peer-state');
    const selfQuiet = silent(a, 'peer-state');
    a.emit('state', { audio: false, hand: true, name: 'Spoof' });
    const p = await update;
    assert.equal(p.id, a.id);
    assert.equal(p.audio, false);
    assert.equal(p.hand, true);
    assert.equal(p.name, 'A');
    assert.equal(await selfQuiet, true);

    // A no-op update is not broadcast.
    const noop = silent(b, 'peer-state');
    a.emit('state', { audio: false });
    assert.equal(await noop, true);
  });

  test('chat is sanitized and broadcast to everyone including the sender', async () => {
    const code = await newMeeting();
    const { c: a } = await joined(code, 'Alice');
    const { c: b } = await joined(code, 'Bob');

    const [atA, atB, ack] = await Promise.all([next(a, 'chat'), next(b, 'chat'), emit(a, 'chat', '  hi <b>bob</b>  ')]);
    assert.equal(ack.ok, true);
    for (const m of [atA, atB, ack.message]) {
      assert.equal(m.text, 'hi <b>bob</b>', 'stored as plain text; client renders with textContent');
      assert.equal(m.name, 'Alice');
      assert.equal(m.from, a.id);
    }
    assert.equal((await emit(a, 'chat', '   ')).ok, false);
    assert.equal((await emit(a, 'chat', { evil: true })).ok, false);
  });

  test('chat is rejected when not in a meeting', async () => {
    const c = await connect();
    assert.equal((await emit(c, 'chat', 'hello')).ok, false);
  });

  test('reactions are whitelisted', async () => {
    const code = await newMeeting();
    const { c: a } = await joined(code, 'A');
    const { c: b } = await joined(code, 'B');
    const r = next(b, 'reaction');
    a.emit('reaction', '🎉');
    assert.deepEqual(await r, { from: a.id, emoji: '🎉' });

    const quiet = silent(b, 'reaction');
    a.emit('reaction', '<script>');
    assert.equal(await quiet, true);
  });
});

describe('socket: leaving', () => {
  test('explicit leave notifies others', async () => {
    const code = await newMeeting();
    const { c: a } = await joined(code, 'A');
    const { c: b } = await joined(code, 'B');
    const left = next(a, 'peer-left');
    assert.deepEqual(await emit(b, 'leave'), { ok: true });
    assert.deepEqual(await left, { id: b.id });
    assert.deepEqual(server.rooms.participants(code).map((p) => p.name), ['A']);
  });

  test('disconnect notifies others and frees the seat', async () => {
    const code = await newMeeting();
    const { c: a } = await joined(code, 'A');
    const { c: b } = await joined(code, 'B');
    const bId = b.id;
    const left = next(a, 'peer-left');
    b.disconnect();
    assert.deepEqual(await left, { id: bId });
    assert.equal(server.rooms.participants(code).length, 1);
  });

  test('signals to a peer who left are dropped', async () => {
    const code = await newMeeting();
    const { c: a } = await joined(code, 'A');
    const { c: b } = await joined(code, 'B');
    const bId = b.id;
    const left = next(a, 'peer-left');
    await emit(b, 'leave');
    await left;
    const quiet = silent(b, 'signal');
    a.emit('signal', { to: bId, data: {} });
    assert.equal(await quiet, true);
  });
});
