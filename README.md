# Meetup

A Google Meet-style video meeting app: Node.js + Express + Socket.IO for signaling, WebRTC (full mesh) for peer-to-peer audio/video. No build step.

## Run it

```bash
npm install
npm start
```

Open http://localhost:3000, click **New meeting**, and share the link (e.g. `http://localhost:3000/abc-defg-hij`).

> Browsers only allow camera and mic on **HTTPS or localhost**. To use it across machines, put it behind HTTPS (a reverse proxy, or a tunnel such as ngrok or Cloudflare Tunnel).
> For users on restrictive networks, add a TURN server: `ICE_SERVERS='[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]' npm start`

## Deploy to Render

This repo includes a [Render Blueprint](render.yaml). In the Render dashboard choose **New → Blueprint**, pick this repository and click **Apply**. Render builds it, gives it an HTTPS URL (needed for camera and mic), and redeploys on every push to `main`.

Vercel isn't suitable: its serverless functions can't keep the long-lived WebSocket connections and in-memory meeting state this app relies on.

## Features

- Meet-style meeting codes and deep links (`/abc-defg-hij`); join by code, code without dashes, or a pasted link
- Green room: camera preview, mic/camera toggles, remembered name, "N people in this call"
- Multi-party video grid (up to 8 people) with auto layout and an active-speaker highlight
- Mute and camera toggles (`Ctrl+D` / `Ctrl+E`); the camera is released when it's off
- Screen sharing (the presenter's tile is enlarged)
- In-call chat with history for late joiners, an unread dot, and toasts
- Raise hand, emoji reactions, people panel, copy meeting link
- Join/leave notifications, rejoin, reconnects automatically if the connection drops
- Recovers if the camera or mic drops out mid-call (retries, then tells others it's off; resumes when the device returns)
- If the browser blocks sound, a "Click to turn on sound" button appears instead of silence
- Tabs left open across an update reload themselves before joining, so nobody joins with outdated code

## Architecture

| File | Role |
|---|---|
| `server/rooms.js` | Pure room model: codes, joining, limits, sanitizing, chat history, cleanup of empty rooms |
| `server/app.js` | HTTP API (`POST /api/meetings`, `GET /api/meetings/:code`, `/api/config`) + Socket.IO signaling relay |
| `public/js/app.js` | UI + WebRTC. The newcomer sends an offer to each existing peer; transceivers are created once, and camera/screen switches use `replaceTrack` (no renegotiation) |
| `public/js/lib.js` | Pure client helpers (code parsing, layout, audio level) |

The server only relays signals between members of the **same** room, and only broadcasts allow-listed state flags and reactions. Chat is rendered with `textContent` (no HTML injection).

## Tests

```bash
npm test             # everything
npm run test:unit    # 40 unit + integration tests (node:test, real Socket.IO clients)
npm run test:e2e     # 20 Playwright tests: real WebRTC calls between separate browser sessions
```

The end-to-end tests use your installed Google Chrome with a fake camera and mic. To use Playwright's own Chromium instead: `npx playwright install chromium` and then `PW_CHANNEL=chromium npm run test:e2e`.

## Troubleshooting audio

Start the server with `MEETUP_DEBUG=1` and every participant's browser reports its audio state to the server log every few seconds: mic state and level, audio bytes sent and received, and whether the playback element is actually playing.

```bash
MEETUP_DEBUG=1 npm start
```

On Windows PowerShell: `$env:MEETUP_DEBUG=1; npm start`

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Interface to bind |
| `ICE_SERVERS` | Google public STUN | JSON array of STUN/TURN servers |
| `MEETUP_DEBUG` | off | Log joins and per-client audio diagnostics |
