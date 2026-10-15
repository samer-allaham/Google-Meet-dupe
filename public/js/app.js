import {
  parseMeetingCode,
  gridColumns,
  initial,
  avatarColor,
  formatClock,
  formatHomeClock,
  audioLevel,
  peopleInCallText,
} from './lib.js';

const $ = (id) => document.getElementById(id);
const REACTIONS = ['👍', '❤️', '😂', '😮', '👏', '🎉'];
const VIDEO_CONSTRAINTS = { width: { ideal: 1280 }, height: { ideal: 720 } };
const SPEAKING_THRESHOLD = 0.04;

const state = {
  code: null,
  iceServers: null,
  socket: null,
  selfId: null,
  name: '',
  mediaReady: null, // Promise while/after acquiring devices
  audioTrack: null,
  videoTrack: null, // camera
  screenTrack: null,
  hasMic: false,
  hasCamera: false,
  audioOn: true,
  videoOn: true,
  hand: false,
  inMeeting: false,
  peers: new Map(), // id -> { info, pc, stream, tile, pending, queue, audioTx, videoTx }
  panel: null,
  lobbyTimer: null,
  camBusy: false,
  mediaSettled: false, // device acquisition finished (toggles before that are remembered, not ignored)
  cameraLost: false, // camera dropped out (not turned off by the user); resume when it reappears
};

// ---------------------------------------------------------------- utilities

function showView(name) {
  for (const v of ['home', 'lobby', 'meeting', 'left']) $(`view-${v}`).hidden = v !== name;
  document.body.dataset.view = name;
}

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  const box = $('toasts');
  box.append(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  setTimeout(() => el.remove(), 4000);
}

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    return null;
  }
}

function setError(el, message) {
  el.textContent = message ?? '';
  el.hidden = !message;
}

function navigate(path) {
  history.pushState({}, '', path);
  route();
}

function setIcon(btn, icon) {
  btn.querySelector('use').setAttribute('href', `#i-${icon}`);
}

setInterval(() => {
  const now = new Date();
  $('home-clock').textContent = formatHomeClock(now);
  $('meeting-clock').textContent = formatClock(now);
}, 1000);

// ---------------------------------------------------------------- routing

async function route() {
  clearInterval(state.lobbyTimer);
  if (state.inMeeting) leaveMeeting({ showLeft: false });
  const raw = location.pathname.slice(1);
  const code = raw ? parseMeetingCode(raw) : null;
  if (code) return openLobby(code);
  if (raw) history.replaceState({}, '', '/');
  stopLocalMedia();
  showView('home');
}

window.addEventListener('popstate', route);

// ---------------------------------------------------------------- home

$('join-code').addEventListener('input', (e) => {
  $('join-btn').disabled = !e.target.value.trim();
  setError($('home-error'), null);
});

$('new-meeting').addEventListener('click', async () => {
  const btn = $('new-meeting');
  btn.disabled = true;
  try {
    const res = await fetch('/api/meetings', { method: 'POST' });
    if (!res.ok) throw new Error();
    const { code } = await res.json();
    navigate(`/${code}`);
  } catch {
    setError($('home-error'), 'Could not create a meeting. Please try again.');
  } finally {
    btn.disabled = false;
  }
});

$('join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = parseMeetingCode($('join-code').value);
  if (!code) return setError($('home-error'), 'Check your meeting code. It should look like abc-defg-hij.');
  const res = await fetch(`/api/meetings/${code}`).catch(() => null);
  if (!res?.ok) return setError($('home-error'), `Meeting "${code}" was not found. Check the code and try again.`);
  navigate(`/${code}`);
});

// ---------------------------------------------------------------- local media

function acquireMedia() {
  state.mediaReady ??= (async () => {
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) {
      setError($('media-error'), 'Camera and microphone need a secure connection (HTTPS or localhost).');
    } else {
      try {
        const s = await md.getUserMedia({ audio: true, video: VIDEO_CONSTRAINTS });
        state.audioTrack = s.getAudioTracks()[0] ?? null;
        state.videoTrack = s.getVideoTracks()[0] ?? null;
      } catch {
        // One device may be missing or blocked; try each on its own.
        state.audioTrack = await md.getUserMedia({ audio: true }).then((s) => s.getAudioTracks()[0], () => null);
        state.videoTrack = await md.getUserMedia({ video: VIDEO_CONSTRAINTS }).then((s) => s.getVideoTracks()[0], () => null);
      }
      watchTrack(state.audioTrack);
      watchTrack(state.videoTrack);
      const missing = [!state.audioTrack && 'microphone', !state.videoTrack && 'camera'].filter(Boolean);
      const effect = [!state.videoTrack && 'see', !state.audioTrack && 'hear'].filter(Boolean).join(' or ');
      setError($('media-error'), missing.length ? `Can't access your ${missing.join(' or ')}. Others won't ${effect} you.` : null);
    }
    state.hasMic = Boolean(state.audioTrack);
    state.hasCamera = Boolean(state.videoTrack);
    state.mediaSettled = true;
    state.audioOn = state.hasMic && state.audioOn;
    state.videoOn = state.hasCamera && state.videoOn;
    if (state.audioTrack) state.audioTrack.enabled = state.audioOn;
    if (!state.videoOn && state.videoTrack) {
      state.videoTrack.stop();
      state.videoTrack = null;
    }
    renderMediaButtons();
    renderPreview();
  })();
  return state.mediaReady;
}

/** Recover when a device track ends on its own (unplugged, revoked, grabbed by another app). */
function watchTrack(track) {
  track?.addEventListener('ended', () => onDeviceEnded(track));
  return track;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Devices can be briefly busy (e.g. another app releasing them), so retry with backoff. */
async function reopenDevice(constraints) {
  for (const wait of [0, 500, 1500]) {
    await sleep(wait);
    try {
      return (await navigator.mediaDevices.getUserMedia(constraints)).getTracks()[0];
    } catch {
      // try again
    }
  }
  return null;
}

async function onDeviceEnded(track) {
  const audio = track.kind === 'audio';
  const key = audio ? 'audioTrack' : 'videoTrack';
  if (state[key] !== track) return; // stopped on purpose or already replaced
  state[key] = null;
  const replacement = await reopenDevice(audio ? { audio: true } : { video: VIDEO_CONSTRAINTS });
  const stillWanted = state.mediaReady && state[key] === null && (audio || state.videoOn);
  if (!stillWanted) {
    replacement?.stop();
    return;
  }
  if (replacement) {
    state[key] = watchTrack(replacement);
    if (audio) replacement.enabled = state.audioOn;
  } else if (audio) {
    state.hasMic = false;
    state.audioOn = false;
    toast('Your microphone was disconnected');
  } else {
    state.videoOn = false;
    state.cameraLost = true;
    toast('Your camera was disconnected');
  }
  renderMediaButtons();
  renderPreview();
  if (!state.inMeeting) return;
  if (audio) {
    await Promise.all([...state.peers.values()].map((p) => p.audioTx?.sender.replaceTrack(state.audioTrack).catch(console.warn)));
    delete $('grid').querySelector('[data-peer-id="self"]')?.dataset.monitored;
  } else {
    await updateVideoSenders();
  }
  state.socket?.emit('state', audio ? { audio: state.audioOn } : { video: state.videoOn });
  renderSelfTile();
  renderPeople();
}

navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  if (state.cameraLost && state.mediaReady) setVideo(true);
});

function stopLocalMedia() {
  for (const t of [state.audioTrack, state.videoTrack, state.screenTrack]) t?.stop();
  state.audioTrack = state.videoTrack = state.screenTrack = null;
  state.mediaReady = null;
  state.audioOn = true;
  state.videoOn = true;
  state.cameraLost = false;
  state.mediaSettled = false;
}

function currentVideoTrack() {
  return state.screenTrack ?? (state.videoOn ? state.videoTrack : null);
}

function setAudio(on) {
  if (!state.mediaSettled) {
    state.audioOn = on;
    return renderMediaButtons();
  }
  if (!state.hasMic) return;
  state.audioOn = on;
  if (state.audioTrack) state.audioTrack.enabled = on;
  renderMediaButtons();
  if (state.inMeeting) {
    state.socket.emit('state', { audio: on });
    renderSelfTile();
    renderPeople();
  }
}

async function setVideo(on) {
  state.cameraLost = false;
  if (!state.mediaSettled) {
    state.videoOn = on;
    return renderMediaButtons();
  }
  if (!state.hasCamera || state.camBusy || on === state.videoOn) return;
  state.camBusy = true;
  try {
    if (on) {
      const s = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS });
      state.videoTrack = watchTrack(s.getVideoTracks()[0]);
    } else {
      state.videoTrack?.stop();
      state.videoTrack = null;
    }
    state.videoOn = on;
  } catch {
    toast("Couldn't start your camera");
  } finally {
    state.camBusy = false;
  }
  renderMediaButtons();
  renderPreview();
  if (state.inMeeting) {
    await updateVideoSenders();
    state.socket.emit('state', { video: state.videoOn });
    renderSelfTile();
  }
}

async function updateVideoSenders() {
  const track = currentVideoTrack();
  await Promise.all(
    [...state.peers.values()].map((p) => p.videoTx?.sender.replaceTrack(track).catch((e) => console.warn(e))),
  );
}

function renderMediaButtons() {
  for (const id of ['lobby-mic', 'btn-mic']) {
    const b = $(id);
    b.classList.toggle('off', !state.audioOn);
    b.disabled = state.mediaSettled && !state.hasMic;
    b.setAttribute('aria-label', state.audioOn ? 'Turn off microphone' : 'Turn on microphone');
    b.setAttribute('aria-pressed', String(!state.audioOn));
    setIcon(b, state.audioOn ? 'mic' : 'mic-off');
  }
  for (const id of ['lobby-cam', 'btn-cam']) {
    const b = $(id);
    b.classList.toggle('off', !state.videoOn);
    b.disabled = state.mediaSettled && !state.hasCamera;
    b.setAttribute('aria-label', state.videoOn ? 'Turn off camera' : 'Turn on camera');
    b.setAttribute('aria-pressed', String(!state.videoOn));
    setIcon(b, state.videoOn ? 'cam' : 'cam-off');
  }
}

function renderPreview() {
  const v = $('preview-video');
  const on = state.videoOn && state.videoTrack;
  v.srcObject = on ? new MediaStream([state.videoTrack]) : null;
  if (on) v.play().catch(() => {});
  v.hidden = !on;
  $('preview-off').hidden = Boolean(on);
}

$('lobby-mic').addEventListener('click', () => setAudio(!state.audioOn));
$('lobby-cam').addEventListener('click', () => setVideo(!state.videoOn));
$('btn-mic').addEventListener('click', () => setAudio(!state.audioOn));
$('btn-cam').addEventListener('click', () => setVideo(!state.videoOn));

// ---------------------------------------------------------------- lobby

async function openLobby(code) {
  state.code = code;
  $('lobby-code').textContent = code;
  setError($('lobby-error'), null);
  showView('lobby');

  const nameInput = $('name-input');
  if (!nameInput.value) nameInput.value = storage('meetup:name') ?? '';
  $('join-now').disabled = !nameInput.value.trim();

  const exists = await refreshLobbyStatus();
  if (!exists) return;
  clearInterval(state.lobbyTimer);
  state.lobbyTimer = setInterval(refreshLobbyStatus, 5000);
  await acquireMedia();
  nameInput.focus();
}

async function refreshLobbyStatus() {
  const res = await fetch(`/api/meetings/${state.code}`).catch(() => null);
  if (res?.status === 404 || res?.status === 400) {
    clearInterval(state.lobbyTimer);
    history.replaceState({}, '', '/');
    showView('home');
    setError($('home-error'), `Meeting "${state.code}" was not found or has ended.`);
    return false;
  }
  if (res?.ok) {
    const { participants } = await res.json();
    $('lobby-status').textContent = peopleInCallText(participants);
  }
  return true;
}

$('name-input').addEventListener('input', (e) => {
  $('join-now').disabled = !e.target.value.trim();
});

$('lobby-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('name-input').value.trim();
  if (!name) return;
  $('join-now').disabled = true;
  try {
    await acquireMedia();
    state.name = name;
    storage('meetup:name', name);
    await joinMeeting();
  } finally {
    $('join-now').disabled = false;
  }
});

// ---------------------------------------------------------------- meeting

const loadedConfig = fetch('/api/config').then((r) => r.json(), () => null);

async function joinMeeting() {
  const [initial, latest] = await Promise.all([loadedConfig, fetch('/api/config').then((r) => r.json(), () => null)]);
  // The app is a single page, so a tab can outlive an update. Never join a call with stale code.
  if (initial?.version && latest?.version && initial.version !== latest.version) {
    location.reload();
    return new Promise(() => {});
  }
  state.iceServers = latest?.iceServers ?? initial?.iceServers ?? [];

  const socket = io({ transports: ['websocket', 'polling'] });
  state.socket = socket;
  bindSocket(socket);

  const res = await emitJoin(socket);
  if (!res?.ok) {
    socket.disconnect();
    state.socket = null;
    setError($('lobby-error'), res?.message ?? 'Could not join the meeting.');
    return;
  }
  clearInterval(state.lobbyTimer);
  state.inMeeting = true;
  showView('meeting');
  $('meeting-code').textContent = state.code;
  $('info-link').textContent = `${location.origin}/${state.code}`;
  $('messages').replaceChildren();
  for (const m of res.chat) appendMessage(m, { silent: true });
  enterRoom(res);
  startSpeakingLoop();
  if (latest?.debug) startDiagnostics();
}

function emitJoin(socket) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, message: 'Could not reach the server.' }), 10000);
    socket.emit(
      'join',
      { code: state.code, name: state.name, audio: state.audioOn, video: state.videoOn },
      (res) => {
        clearTimeout(timer);
        resolve(res);
      },
    );
  });
}

function enterRoom(res) {
  state.selfId = res.self.id;
  $('grid').replaceChildren();
  createTile('self', true);
  renderSelfTile();
  // Newcomer initiates a connection to everyone already in the room.
  for (const p of res.participants) addPeer(p, true);
  if (state.screenTrack || state.hand) state.socket.emit('state', { screen: Boolean(state.screenTrack), hand: state.hand });
  renderLayout();
  renderPeople();
}

function bindSocket(socket) {
  let everDisconnected = false;

  socket.on('peer-joined', (p) => {
    addPeer(p, false);
    toast(`${p.name} joined`);
  });

  socket.on('peer-left', ({ id }) => {
    const peer = state.peers.get(id);
    if (!peer) return;
    toast(`${peer.info.name} left`);
    removePeer(id);
  });

  socket.on('peer-state', (p) => {
    const peer = state.peers.get(p.id);
    if (!peer) return;
    if (p.hand && !peer.info.hand) toast(`${p.name} raised a hand`);
    if (p.screen && !peer.info.screen) toast(`${p.name} is presenting`);
    peer.info = p;
    renderPeerTile(peer);
    renderLayout();
    renderPeople();
  });

  socket.on('signal', ({ from, data }) => handleSignal(from, data));

  socket.on('chat', (m) => appendMessage(m));

  socket.on('reaction', showReaction);

  socket.on('disconnect', (reason) => {
    if (!state.inMeeting || reason === 'io client disconnect') return;
    everDisconnected = true;
    toast('Connection lost. Reconnecting…');
    for (const id of [...state.peers.keys()]) removePeer(id);
  });

  socket.on('connect', async () => {
    if (!everDisconnected || !state.inMeeting) return;
    const res = await emitJoin(socket);
    if (res?.ok) {
      toast('Reconnected');
      enterRoom(res);
    } else {
      toast(res?.message ?? 'Could not rejoin the meeting.');
      leaveMeeting();
    }
  });
}

function sendSignal(to, data) {
  state.socket?.emit('signal', { to, data });
}

function enqueue(peer, task) {
  peer.queue = peer.queue.then(task).catch((e) => console.warn('signaling error', e));
  return peer.queue;
}

function addPeer(info, initiator) {
  const existing = state.peers.get(info.id);
  if (existing) return existing;

  const pc = new RTCPeerConnection({ iceServers: state.iceServers ?? [] });
  const peer = {
    info,
    pc,
    stream: new MediaStream(),
    pending: [],
    queue: Promise.resolve(),
    audioTx: null,
    videoTx: null,
    tile: null,
    initiator,
  };
  state.peers.set(info.id, peer);
  peer.tile = createTile(info.id, false);
  renderPeerTile(peer);

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal(info.id, { candidate: e.candidate.toJSON() });
  };

  pc.ontrack = (e) => {
    for (const t of peer.stream.getTracks()) if (t.kind === e.track.kind) peer.stream.removeTrack(t);
    peer.stream.addTrack(e.track);
    // Audio gets its own element: a <video> waits for a first video frame before playing,
    // so someone who joins with their camera off would otherwise never be heard.
    const el = peer.tile.querySelector(e.track.kind === 'audio' ? 'audio' : 'video');
    el.srcObject = new MediaStream([e.track]);
    el.play().catch(() => e.track.kind === 'audio' && askToEnableSound());
    if (e.track.kind === 'audio') monitorAudio(peer.tile, el.srcObject);
  };

  pc.onconnectionstatechange = () => {
    peer.tile.dataset.connection = pc.connectionState;
    if (pc.connectionState === 'failed' && peer.initiator) {
      enqueue(peer, async () => {
        await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
        sendSignal(info.id, { description: pc.localDescription.toJSON() });
      });
    }
  };

  if (initiator) {
    // Transceivers are created once; later camera/screen switches use replaceTrack (no renegotiation).
    peer.audioTx = pc.addTransceiver(state.audioTrack ?? 'audio', { direction: 'sendrecv' });
    peer.videoTx = pc.addTransceiver(currentVideoTrack() ?? 'video', { direction: 'sendrecv' });
    enqueue(peer, async () => {
      await pc.setLocalDescription(await pc.createOffer());
      sendSignal(info.id, { description: pc.localDescription.toJSON() });
    });
  }

  renderLayout();
  renderPeople();
  return peer;
}

function handleSignal(from, data) {
  if (!state.inMeeting || !data) return;
  // An offer can only come from someone the server already announced, but be lenient.
  const peer = state.peers.get(from) ?? addPeer({ id: from, name: 'Guest', audio: true, video: true }, false);
  const { pc } = peer;

  enqueue(peer, async () => {
    if (data.description) {
      await pc.setRemoteDescription(data.description);
      if (data.description.type === 'offer') {
        if (!peer.videoTx) await attachAsAnswerer(peer);
        await pc.setLocalDescription(await pc.createAnswer());
        sendSignal(from, { description: pc.localDescription.toJSON() });
      }
      for (const c of peer.pending.splice(0)) await pc.addIceCandidate(c).catch((e) => console.warn(e));
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch((e) => console.warn(e));
      else peer.pending.push(data.candidate);
    }
  });
}

async function attachAsAnswerer(peer) {
  for (const tx of peer.pc.getTransceivers()) {
    const kind = tx.receiver.track.kind;
    if (kind === 'audio' && !peer.audioTx) {
      peer.audioTx = tx;
      tx.direction = 'sendrecv';
      await tx.sender.replaceTrack(state.audioTrack);
    } else if (kind === 'video' && !peer.videoTx) {
      peer.videoTx = tx;
      tx.direction = 'sendrecv';
      await tx.sender.replaceTrack(currentVideoTrack());
    }
  }
}

function removePeer(id) {
  const peer = state.peers.get(id);
  if (!peer) return;
  state.peers.delete(id);
  peer.pc.close();
  peer.tile.remove();
  renderLayout();
  renderPeople();
}

function leaveMeeting({ showLeft = true } = {}) {
  if (state.socket) {
    state.socket.emit('leave');
    state.socket.disconnect();
    state.socket = null;
  }
  for (const id of [...state.peers.keys()]) removePeer(id);
  state.inMeeting = false;
  state.hand = false;
  state.panel = null;
  $('panel').hidden = true;
  $('grid').replaceChildren();
  $('chat-dot').hidden = true;
  stopSpeakingLoop();
  clearInterval(diagTimer);
  stopLocalMedia();
  if (showLeft) showView('left');
}

$('btn-leave').addEventListener('click', () => leaveMeeting());
$('rejoin').addEventListener('click', () => openLobby(state.code));
$('home-btn').addEventListener('click', () => navigate('/'));

// ---------------------------------------------------------------- tiles & layout

function createTile(id, isSelf) {
  const tile = $('tile-tpl').content.firstElementChild.cloneNode(true);
  tile.dataset.peerId = id;
  tile.classList.toggle('self', isSelf);
  if (isSelf) tile.querySelector('audio').remove();
  $('grid').append(tile);
  return tile;
}

function applyTileState(tile, { name, audio, video, screen, hand }, color, label) {
  tile.dataset.name = name;
  tile.classList.toggle('muted', !audio);
  tile.classList.toggle('video-off', !(video || screen));
  tile.classList.toggle('screen', Boolean(screen));
  tile.classList.toggle('presenting', Boolean(screen));
  tile.classList.toggle('hand', Boolean(hand));
  tile.querySelector('.tile-name').textContent = label;
  const av = tile.querySelector('.avatar span');
  av.textContent = initial(name);
  av.style.setProperty('--avatar', color);
}

function renderSelfTile() {
  const tile = $('grid').querySelector('[data-peer-id="self"]');
  if (!tile) return;
  const track = currentVideoTrack();
  const video = tile.querySelector('video');
  const current = video.srcObject?.getVideoTracks?.()[0] ?? null;
  if (current !== track) {
    video.srcObject = track ? new MediaStream([track]) : null;
    if (track) video.play().catch(() => {});
  }
  applyTileState(
    tile,
    { name: state.name, audio: state.audioOn, video: state.videoOn, screen: Boolean(state.screenTrack), hand: state.hand },
    avatarColor(state.selfId),
    state.screenTrack ? 'You are presenting' : `${state.name} (You)`,
  );
  if (state.audioTrack && !tile.dataset.monitored) {
    tile.dataset.monitored = '1';
    monitorAudio(tile, new MediaStream([state.audioTrack]));
  }
}

function renderPeerTile(peer) {
  const { info } = peer;
  applyTileState(peer.tile, info, avatarColor(info.id), info.screen ? `${info.name} (Presenting)` : info.name);
}

function renderLayout() {
  const grid = $('grid');
  const count = grid.children.length;
  const presenting = grid.querySelector('.presenting');
  const cols = gridColumns(presenting ? count - 1 : count, { narrow: innerWidth < 760 });
  grid.style.setProperty('--cols', String(Math.max(cols, 1)));
  $('people-count').textContent = String(count || 1);
}

window.addEventListener('resize', renderLayout);

// ---------------------------------------------------------------- speaking indicator

const audio = { ctx: null, monitors: [], timer: null };

function monitorAudio(tile, stream) {
  try {
    audio.ctx ??= new AudioContext();
    audio.ctx.resume?.();
    const src = audio.ctx.createMediaStreamSource(stream);
    const analyser = audio.ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    audio.monitors = audio.monitors.filter((m) => m.tile !== tile);
    audio.monitors.push({ tile, analyser, buf: new Uint8Array(analyser.fftSize) });
  } catch (e) {
    console.warn('audio level unavailable', e);
  }
}

function startSpeakingLoop() {
  clearInterval(audio.timer);
  audio.timer = setInterval(() => {
    audio.monitors = audio.monitors.filter((m) => m.tile.isConnected);
    for (const m of audio.monitors) {
      m.analyser.getByteTimeDomainData(m.buf);
      const muted = m.tile.classList.contains('muted');
      m.tile.classList.toggle('speaking', !muted && audioLevel(m.buf) > SPEAKING_THRESHOLD);
    }
  }, 150);
}

function stopSpeakingLoop() {
  clearInterval(audio.timer);
  audio.monitors = [];
}

// ---------------------------------------------------------------- screen share

async function startScreenShare() {
  if (!navigator.mediaDevices?.getDisplayMedia) return toast('Screen sharing is not supported in this browser');
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch {
    return; // user cancelled the picker
  }
  if (!state.inMeeting) return stream.getTracks().forEach((t) => t.stop());
  state.screenTrack = stream.getVideoTracks()[0];
  state.screenTrack.addEventListener('ended', stopScreenShare);
  await updateVideoSenders();
  state.socket.emit('state', { screen: true });
  $('btn-screen').classList.add('active');
  $('btn-screen').setAttribute('aria-label', 'Stop presenting');
  renderSelfTile();
  renderLayout();
}

async function stopScreenShare() {
  if (!state.screenTrack) return;
  state.screenTrack.stop();
  state.screenTrack = null;
  $('btn-screen').classList.remove('active');
  $('btn-screen').setAttribute('aria-label', 'Present now');
  if (!state.inMeeting) return;
  await updateVideoSenders();
  state.socket.emit('state', { screen: false });
  renderSelfTile();
  renderLayout();
}

$('btn-screen').addEventListener('click', () => (state.screenTrack ? stopScreenShare() : startScreenShare()));

// ---------------------------------------------------------------- hand & reactions

$('btn-hand').addEventListener('click', () => {
  state.hand = !state.hand;
  state.socket.emit('state', { hand: state.hand });
  $('btn-hand').classList.toggle('active', state.hand);
  $('btn-hand').setAttribute('aria-label', state.hand ? 'Lower hand' : 'Raise hand');
  renderSelfTile();
  renderPeople();
});

for (const emoji of REACTIONS) {
  const b = document.createElement('button');
  b.textContent = emoji;
  b.setAttribute('aria-label', `React with ${emoji}`);
  b.addEventListener('click', () => {
    state.socket?.emit('reaction', emoji);
    $('react-menu').hidden = true;
  });
  $('react-menu').append(b);
}

$('btn-react').addEventListener('click', (e) => {
  e.stopPropagation();
  $('react-menu').hidden = !$('react-menu').hidden;
  $('btn-react').classList.toggle('active', !$('react-menu').hidden);
});

document.addEventListener('click', (e) => {
  if (!$('react-menu').hidden && !e.target.closest('.react-wrap')) {
    $('react-menu').hidden = true;
    $('btn-react').classList.remove('active');
  }
});

function showReaction({ from, emoji }) {
  const who = from === state.selfId ? 'You' : (state.peers.get(from)?.info.name ?? '');
  const el = document.createElement('div');
  el.className = 'floating-reaction';
  el.dataset.testid = 'reaction';
  el.style.left = `${Math.random() * 120}px`;
  const em = document.createElement('span');
  em.className = 'emoji';
  em.textContent = emoji;
  const name = document.createElement('span');
  name.className = 'who';
  name.textContent = who;
  el.append(em, name);
  $('reactions-layer').append(el);
  el.addEventListener('animationend', () => el.remove());
}

// ---------------------------------------------------------------- side panel

const PANELS = { chat: 'In-call messages', people: 'People', info: 'Meeting details' };

function togglePanel(name) {
  state.panel = state.panel === name ? null : name;
  $('panel').hidden = !state.panel;
  for (const key of Object.keys(PANELS)) {
    $(`panel-${key}`).hidden = state.panel !== key;
    $(`btn-${key}`).classList.toggle('active', state.panel === key);
  }
  if (state.panel) $('panel-title').textContent = PANELS[state.panel];
  if (state.panel === 'chat') {
    $('chat-dot').hidden = true;
    $('chat-input').focus();
    $('messages').scrollTop = $('messages').scrollHeight;
  }
}

$('btn-chat').addEventListener('click', () => togglePanel('chat'));
$('btn-people').addEventListener('click', () => togglePanel('people'));
$('btn-info').addEventListener('click', () => togglePanel('info'));
$('panel-close').addEventListener('click', () => togglePanel(state.panel));

$('copy-link').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('info-link').textContent);
    toast('Copied meeting link');
  } catch {
    toast("Couldn't copy. Select the link and copy it manually.");
  }
});

function renderPeople() {
  const list = $('people');
  const rows = [
    { id: state.selfId, name: `${state.name} (You)`, audio: state.audioOn, hand: state.hand },
    ...[...state.peers.values()].map((p) => p.info),
  ];
  list.replaceChildren(
    ...rows.map((p) => {
      const li = document.createElement('li');
      li.dataset.testid = 'person';
      const av = document.createElement('span');
      av.className = 'pav';
      av.style.background = avatarColor(p.id);
      av.textContent = initial(p.name);
      const nm = document.createElement('span');
      nm.className = 'pname';
      nm.textContent = p.name;
      li.append(av, nm);
      if (p.hand) li.insertAdjacentHTML('beforeend', '<svg class="i" aria-label="Hand raised"><use href="#i-hand"/></svg>');
      li.insertAdjacentHTML('beforeend', `<svg class="i" aria-label="${p.audio ? 'Mic on' : 'Muted'}"><use href="#i-${p.audio ? 'mic' : 'mic-off'}"/></svg>`);
      return li;
    }),
  );
  $('people-count').textContent = String(rows.length);
}

// ---------------------------------------------------------------- chat

$('chat-input').addEventListener('input', (e) => {
  $('chat-send').disabled = !e.target.value.trim();
});

$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text || !state.socket) return;
  state.socket.emit('chat', text, (res) => {
    if (!res?.ok) toast('Message not sent');
  });
  input.value = '';
  $('chat-send').disabled = true;
});

function appendMessage(m, { silent = false } = {}) {
  const mine = m.from === state.selfId;
  const li = document.createElement('li');
  li.dataset.testid = 'message';
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = mine ? 'You' : m.name;
  const time = document.createElement('time');
  time.textContent = formatClock(new Date(m.at));
  meta.append(time);
  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = m.text;
  li.append(meta, text);
  const list = $('messages');
  list.append(li);
  list.scrollTop = list.scrollHeight;

  if (!silent && !mine && state.panel !== 'chat') {
    $('chat-dot').hidden = false;
    toast(`${m.name}: ${m.text.length > 60 ? `${m.text.slice(0, 60)}…` : m.text}`);
  }
}

// ---------------------------------------------------------------- diagnostics

// Periodic audio health report, logged by the server when MEETUP_DEBUG is set.
let diagTimer = null;
const round = (n) => (typeof n === 'number' ? Math.round(n * 1e4) / 1e4 : n);

function startDiagnostics() {
  clearInterval(diagTimer);
  const report = async () => {
    if (!state.socket || !state.inMeeting) return;
    const peers = [];
    for (const p of state.peers.values()) {
      const s = {};
      try {
        for (const r of (await p.pc.getStats()).values()) {
          if (r.kind !== 'audio') continue;
          if (r.type === 'inbound-rtp') Object.assign(s, { inBytes: r.bytesReceived, inLevel: round(r.audioLevel) });
          if (r.type === 'outbound-rtp') s.outBytes = r.bytesSent;
          if (r.type === 'media-source') s.micLevel = round(r.audioLevel);
        }
      } catch {}
      const a = p.tile.querySelector('audio');
      const rt = a?.srcObject?.getAudioTracks()[0];
      peers.push({
        peer: p.info.name,
        conn: p.pc.connectionState,
        ...s,
        player: a ? `${a.paused ? 'PAUSED' : 'playing'} ready=${a.readyState} muted=${a.muted} vol=${a.volume} t=${a.currentTime.toFixed(1)}` : 'NO <audio> ELEMENT',
        recvTrack: rt ? `${rt.readyState}${rt.muted ? ' MUTED' : ''}` : 'none',
        sendAudio: p.audioTx?.sender.track ? `${p.audioTx.sender.track.readyState} enabled=${p.audioTx.sender.track.enabled}` : 'NONE',
        sendVideo: p.audioTx ? (p.videoTx?.sender.track ? 'yes' : 'none') : '?',
      });
    }
    const mic = state.audioTrack;
    state.socket.emit('diag', {
      version: (await loadedConfig)?.version,
      browser: navigator.userAgent.match(/(Edg|OPR|Firefox|Chrome|Safari)\/[\d.]+/g)?.join(' '),
      micOn: state.audioOn,
      camOn: state.videoOn,
      mic: mic ? `${mic.readyState} enabled=${mic.enabled}${mic.muted ? ' MUTED' : ''} "${mic.label}"` : 'NONE',
      soundButton: !$('enable-sound').hidden,
      peers,
    });
  };
  report();
  diagTimer = setInterval(report, 4000);
}

// ---------------------------------------------------------------- sound unlock

/** Browsers may refuse to start audio without a user gesture; offer one instead of staying silent. */
function askToEnableSound() {
  $('enable-sound').hidden = false;
}

$('enable-sound').addEventListener('click', async () => {
  const players = [...document.querySelectorAll('#grid audio')].filter((a) => a.srcObject);
  await Promise.all(players.map((a) => a.play().catch(() => {})));
  $('enable-sound').hidden = !players.some((a) => a.paused);
});

// ---------------------------------------------------------------- keyboard shortcuts

document.addEventListener('keydown', (e) => {
  if (!state.inMeeting || !(e.ctrlKey || e.metaKey)) return;
  const key = e.key.toLowerCase();
  if (key === 'd') {
    e.preventDefault();
    setAudio(!state.audioOn);
  } else if (key === 'e') {
    e.preventDefault();
    setVideo(!state.videoOn);
  }
});

window.addEventListener('beforeunload', () => state.socket?.disconnect());

route();
