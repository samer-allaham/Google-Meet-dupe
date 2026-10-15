import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------- helpers

let contexts = [];
let pageErrors = [];
let keepAlive;

// Chrome's video capture service can shut down when idle and drop the fake camera mid-test.
// Hold one camera stream open for the whole run so it never goes idle.
test.beforeAll(async ({ browser }) => {
  keepAlive = await browser.newContext();
  const page = await keepAlive.newPage();
  await page.goto('/healthz');
  await page.evaluate(() => navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then((s) => (window.__hold = s)));
});

test.afterAll(async () => {
  await keepAlive?.close();
});

test.beforeEach(() => {
  contexts = [];
  pageErrors = [];
});

test.afterEach(async () => {
  // Release camera/mic before closing so Chrome's shared fake device is free for the next test.
  const pages = contexts.flatMap((c) => c.pages());
  await Promise.all(pages.map((p) => p.goto('about:blank').catch(() => {})));
  await Promise.all(contexts.map((c) => c.close().catch(() => {})));
  expect(pageErrors, 'uncaught errors in the page').toEqual([]);
});

async function newUser(browser) {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  page.on('pageerror', (err) => pageErrors.push(err.message));
  return page;
}

async function createMeeting(page) {
  await page.goto('/');
  await page.getByTestId('new-meeting').click();
  await expect(page).toHaveURL(/\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  return page.url().split('/').pop();
}

async function joinAs(page, name) {
  await expect(page.getByTestId('lobby-code')).toBeVisible();
  await page.getByTestId('name-input').fill(name);
  await page.getByTestId('join-now').click();
  await expect(page.getByTestId('grid')).toBeVisible();
}

async function startMeeting(browser, names) {
  const pages = [];
  let code;
  for (const name of names) {
    const page = await newUser(browser);
    if (!code) code = await createMeeting(page);
    else await page.goto(`/${code}`);
    await joinAs(page, name);
    pages.push(page);
  }
  for (const page of pages) await expect(page.getByTestId('tile')).toHaveCount(names.length);
  return { code, pages };
}

const remoteTile = (page, name) => page.locator(`[data-testid="tile"][data-name="${name}"]:not(.self)`);

/** Waits until a tile's <video> is actually decoding frames that advance over time. */
async function expectVideoFlowing(tile, { minNewFrames = 5 } = {}) {
  const video = tile.locator('video');
  await expect.poll(() => video.evaluate((v) => v.videoWidth), { message: 'video has dimensions' }).toBeGreaterThan(0);
  const t0 = await video.evaluate((v) => v.getVideoPlaybackQuality?.().totalVideoFrames ?? 0);
  await expect
    .poll(() => video.evaluate((v) => v.getVideoPlaybackQuality?.().totalVideoFrames ?? 0), { message: 'frames advance' })
    .toBeGreaterThan(t0 + minNewFrames - 1);
}

/** Some media element in the tile is playing the remote audio track and its clock is advancing. */
async function expectAudioPlaying(tile) {
  const probe = () =>
    tile.evaluate((t) => {
      const el = [...t.querySelectorAll('audio, video')].find((m) => m.srcObject?.getAudioTracks?.().length);
      return el && !el.paused && el.readyState >= 2 ? el.currentTime : -1;
    });
  await expect.poll(probe, { message: 'remote audio element is playing' }).toBeGreaterThan(0);
  const t0 = await probe();
  await expect.poll(probe, { message: 'remote audio clock advances' }).toBeGreaterThan(t0 + 0.3);
}

async function remoteAudioLive(tile) {
  return tile.locator('audio').evaluate((a) => {
    const t = a.srcObject?.getAudioTracks?.()[0];
    return Boolean(t && t.readyState === 'live');
  });
}

// ---------------------------------------------------------------- tests

test.describe('home & lobby', () => {
  test('create a meeting, preview camera, join', async ({ browser }) => {
    const page = await newUser(browser);
    const code = await createMeeting(page);
    await expect(page.getByTestId('lobby-code')).toHaveText(code);
    await expect(page.getByTestId('lobby-status')).toHaveText('No one else is here');

    // Camera preview is live in the green room.
    await expect.poll(() => page.getByTestId('preview-video').evaluate((v) => v.videoWidth)).toBeGreaterThan(0);

    // Join is disabled until a name is entered.
    await expect(page.getByTestId('join-now')).toBeDisabled();
    await joinAs(page, 'Alice');
    await expect(page.getByTestId('meeting-code')).toHaveText(code);
    const self = page.locator('[data-testid="tile"].self');
    await expect(self).toContainText('Alice (You)');
    await expectVideoFlowing(self);
    await expect(page.getByTestId('people-count')).toHaveText('1');
  });

  test('validates codes on the home screen', async ({ browser }) => {
    const page = await newUser(browser);
    await page.goto('/');
    await expect(page.getByTestId('join-btn')).toBeDisabled();

    await page.getByTestId('join-code').fill('not a code');
    await page.getByTestId('join-btn').click();
    await expect(page.getByTestId('home-error')).toContainText('Check your meeting code');

    await page.getByTestId('join-code').fill('zzz-zzzz-zzz');
    await page.getByTestId('join-btn').click();
    await expect(page.getByTestId('home-error')).toContainText('was not found');
  });

  test('deep link to a missing meeting returns home with an error', async ({ browser }) => {
    const page = await newUser(browser);
    await page.goto('/qqq-qqqq-qqq');
    await expect(page.getByTestId('home-error')).toContainText('not found');
    await expect(page).toHaveURL(/\/$/);
  });

  test('join by pasting a full link; lobby shows who is in the call; name is remembered', async ({ browser }) => {
    const { code } = await startMeeting(browser, ['Host']);
    const guest = await newUser(browser);
    await guest.goto('/');
    await guest.getByTestId('join-code').fill(`http://localhost/${code}`);
    await guest.getByTestId('join-btn').click();
    await expect(guest).toHaveURL(new RegExp(`/${code}$`));
    await expect(guest.getByTestId('lobby-status')).toHaveText('1 other person is in this call');

    await joinAs(guest, 'Guest');
    await guest.getByTestId('btn-leave').click();
    await guest.getByTestId('rejoin').click();
    await expect(guest.getByTestId('name-input')).toHaveValue('Guest');
  });

  test('audio is heard when someone joins with their camera off', async ({ browser }) => {
    const { code, pages: [host] } = await startMeeting(browser, ['Host']);
    const guest = await newUser(browser);
    await guest.goto(`/${code}`);
    await guest.getByTestId('lobby-cam').click();
    await expect(guest.getByTestId('lobby-cam')).toHaveClass(/off/);
    await joinAs(guest, 'NoCam');

    const tile = remoteTile(host, 'NoCam');
    await expect(tile).toHaveClass(/video-off/);
    await expect(tile).not.toHaveClass(/muted/);
    await expectAudioPlaying(tile);
    // And the other direction: the camera-off guest hears the host.
    await expectAudioPlaying(remoteTile(guest, 'Host'));
  });

  test('a tab running outdated code reloads itself instead of joining', async ({ browser }) => {
    const page = await newUser(browser);
    await createMeeting(page);
    await page.getByTestId('name-input').fill('Stale');
    await page.evaluate(() => (window.__oldPage = true));
    // Simulate a deploy: a client file changes while this tab is open.
    const file = new URL('../public/styles.css', import.meta.url);
    const { utimesSync } = await import('node:fs');
    const now = new Date();
    utimesSync(file, now, now);

    await Promise.all([page.waitForEvent('load'), page.getByTestId('join-now').click()]);
    expect(await page.evaluate(() => window.__oldPage ?? false)).toBe(false); // reloaded
    await expect(page.getByTestId('lobby-code')).toBeVisible(); // back in the lobby on the same link
    await joinAs(page, 'Fresh');
    await expect(page.locator('[data-testid="tile"].self')).toContainText('Fresh (You)');
  });

  test('offers a button when the browser blocks audio playback', async ({ browser }) => {
    const { code } = await startMeeting(browser, ['Host']);
    const guest = await newUser(browser);
    // Make the browser refuse to autoplay audio until a click, like a strict autoplay policy.
    await guest.addInitScript(() => {
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        // Only the "turn on sound" click counts as permission in this simulation.
        if (this.tagName === 'AUDIO' && document.activeElement?.id !== 'enable-sound') {
          this.pause();
          return Promise.reject(new DOMException('blocked', 'NotAllowedError'));
        }
        return play.call(this);
      };
      Object.defineProperty(HTMLMediaElement.prototype, 'autoplay', { get: () => false, set() {} });
    });
    await guest.goto(`/${code}`);
    await joinAs(guest, 'Guest');
    await expect(guest.getByTestId('enable-sound')).toBeVisible();
    await guest.getByTestId('enable-sound').click();
    await expect(guest.getByTestId('enable-sound')).toBeHidden();
    await expectAudioPlaying(remoteTile(guest, 'Host'));
  });

  test('mic/camera clicks made before the devices finish starting are remembered', async ({ browser }) => {
    const page = await newUser(browser);
    // Slow down device start-up like real hardware.
    await page.addInitScript(() => {
      if (!navigator.mediaDevices) return;
      const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (c) => new Promise((r) => setTimeout(r, 1500)).then(() => gum(c));
    });
    await createMeeting(page);
    await page.getByTestId('lobby-cam').click();
    await page.getByTestId('lobby-mic').click();
    await expect(page.getByTestId('lobby-cam')).toHaveClass(/off/);
    await expect(page.getByTestId('preview-off')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(2000); // devices have started by now
    await expect(page.getByTestId('lobby-cam')).toHaveClass(/off/);
    await expect(page.getByTestId('lobby-mic')).toHaveClass(/off/);
    await joinAs(page, 'Early');
    await expect(page.locator('[data-testid="tile"].self')).toHaveClass(/video-off/);
    await expect(page.locator('[data-testid="tile"].self')).toHaveClass(/muted/);
  });

  test('can join with mic and camera turned off in the lobby', async ({ browser }) => {
    const { code, pages: [host] } = await startMeeting(browser, ['Host']);
    const guest = await newUser(browser);
    await guest.goto(`/${code}`);
    await guest.getByTestId('lobby-mic').click();
    await guest.getByTestId('lobby-cam').click();
    await expect(guest.getByTestId('lobby-mic')).toHaveClass(/off/);
    await expect(guest.getByTestId('lobby-cam')).toHaveClass(/off/);
    await joinAs(guest, 'Quiet');

    const tile = remoteTile(host, 'Quiet');
    await expect(tile).toHaveClass(/muted/);
    await expect(tile).toHaveClass(/video-off/);
    await expect(tile.locator('.avatar')).toBeVisible();
    await expect(tile.locator('.avatar span')).toHaveText('Q');
  });
});

test.describe('in a call', () => {
  test('two people see and hear each other', async ({ browser }) => {
    const { pages: [a, b] } = await startMeeting(browser, ['Alice', 'Bob']);
    await expectVideoFlowing(remoteTile(a, 'Bob'));
    await expectVideoFlowing(remoteTile(b, 'Alice'));
    expect(await remoteAudioLive(remoteTile(a, 'Bob'))).toBe(true);
    expect(await remoteAudioLive(remoteTile(b, 'Alice'))).toBe(true);
    await expectAudioPlaying(remoteTile(a, 'Bob'));
    await expectAudioPlaying(remoteTile(b, 'Alice'));
    await expect(remoteTile(a, 'Bob')).toHaveAttribute('data-connection', 'connected');
    await expect(a.getByTestId('people-count')).toHaveText('2');
    await expect(a.getByTestId('toasts')).toContainText('Bob joined');
  });

  test('three-way mesh call', async ({ browser }) => {
    const { pages } = await startMeeting(browser, ['Ann', 'Ben', 'Cat']);
    const names = ['Ann', 'Ben', 'Cat'];
    for (const [i, page] of pages.entries()) {
      for (const other of names.filter((_, j) => j !== i)) await expectVideoFlowing(remoteTile(page, other));
      expect(await page.getByTestId('grid').evaluate((g) => g.style.getPropertyValue('--cols'))).toBe('2');
    }
  });

  test('mute and camera toggles propagate', async ({ browser }) => {
    const { pages: [a, b] } = await startMeeting(browser, ['Alice', 'Bob']);
    const aliceOnB = remoteTile(b, 'Alice');
    await expectVideoFlowing(aliceOnB);

    await a.getByTestId('btn-mic').click();
    await expect(a.getByTestId('btn-mic')).toHaveAttribute('aria-label', 'Turn on microphone');
    await expect(aliceOnB).toHaveClass(/muted/);
    await a.keyboard.press('Control+d');
    await expect(aliceOnB).not.toHaveClass(/muted/);

    await a.getByTestId('btn-cam').click();
    await expect(aliceOnB).toHaveClass(/video-off/);
    await expect(a.locator('[data-testid="tile"].self')).toHaveClass(/video-off/);
    // Camera hardware is released when off.
    expect(await a.evaluate(() => document.querySelector('[data-peer-id="self"] video').srcObject)).toBeNull();

    await a.getByTestId('btn-cam').click();
    await expect(aliceOnB).not.toHaveClass(/video-off/);
    await expectVideoFlowing(aliceOnB);
  });

  test('recovers when the camera drops out unexpectedly', async ({ browser }) => {
    const { pages: [a, b] } = await startMeeting(browser, ['Alice', 'Bob']);
    const aliceOnB = remoteTile(b, 'Alice');
    await expectVideoFlowing(aliceOnB);

    const selfTrack = () => a.evaluate(() => document.querySelector('[data-peer-id="self"] video').srcObject?.getVideoTracks()[0]?.id ?? null);
    const before = await selfTrack();
    // Simulate the OS killing the camera (stop() alone doesn't fire "ended").
    await a.evaluate(() => {
      const t = document.querySelector('[data-peer-id="self"] video').srcObject.getVideoTracks()[0];
      t.stop();
      t.dispatchEvent(new Event('ended'));
    });
    await expect.poll(selfTrack).not.toBe(before);
    await expect(aliceOnB).not.toHaveClass(/video-off/);
    await expectVideoFlowing(aliceOnB);

    // If the camera can't be reopened, everyone is told it is off.
    await a.evaluate(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('gone', 'NotReadableError'));
      const t = document.querySelector('[data-peer-id="self"] video').srcObject.getVideoTracks()[0];
      t.stop();
      t.dispatchEvent(new Event('ended'));
    });
    await expect(a.getByTestId('toasts')).toContainText('Your camera was disconnected');
    await expect(a.getByTestId('btn-cam')).toHaveClass(/off/);
    await expect(aliceOnB).toHaveClass(/video-off/);
  });

  test('chat with unread indicator', async ({ browser }) => {
    const { pages: [a, b] } = await startMeeting(browser, ['Alice', 'Bob']);
    await a.getByTestId('btn-chat').click();
    await a.getByTestId('chat-input').fill('Hello <b>Bob</b>!');
    await a.getByTestId('chat-send').click();

    await expect(a.getByTestId('message')).toHaveCount(1);
    await expect(a.getByTestId('message')).toContainText('You');
    await expect(b.getByTestId('chat-dot')).toBeVisible();
    await expect(b.getByTestId('toasts')).toContainText('Alice: Hello <b>Bob</b>!');

    await b.getByTestId('btn-chat').click();
    await expect(b.getByTestId('chat-dot')).toBeHidden();
    const msg = b.getByTestId('message');
    await expect(msg).toContainText('Alice');
    await expect(msg.locator('.text')).toHaveText('Hello <b>Bob</b>!'); // rendered as text, not HTML
    await expect(msg.locator('b')).toHaveCount(0);

    // Enter key also sends.
    await b.getByTestId('chat-input').fill('hi back');
    await b.getByTestId('chat-input').press('Enter');
    await expect(a.getByTestId('message')).toHaveCount(2);
    await expect(a.getByTestId('message').nth(1)).toContainText('hi back');
  });

  test('late joiner receives chat history', async ({ browser }) => {
    const { code, pages: [a] } = await startMeeting(browser, ['Alice']);
    await a.getByTestId('btn-chat').click();
    await a.getByTestId('chat-input').fill('before you came');
    await a.getByTestId('chat-input').press('Enter');
    await expect(a.getByTestId('message')).toHaveCount(1);

    const late = await newUser(browser);
    await late.goto(`/${code}`);
    await joinAs(late, 'Late');
    await late.getByTestId('btn-chat').click();
    await expect(late.getByTestId('message')).toContainText('before you came');
  });

  test('raise hand, people panel and reactions', async ({ browser }) => {
    const { pages: [a, b] } = await startMeeting(browser, ['Alice', 'Bob']);
    await a.getByTestId('btn-hand').click();
    await expect(a.getByTestId('btn-hand')).toHaveClass(/active/);
    await expect(remoteTile(b, 'Alice')).toHaveClass(/hand/);
    await expect(b.getByTestId('toasts')).toContainText('Alice raised a hand');

    await b.getByTestId('btn-people').click();
    const people = b.getByTestId('panel-people').getByTestId('person');
    await expect(people).toHaveCount(2);
    await expect(people.nth(0)).toContainText('Bob (You)');
    await expect(people.filter({ hasText: 'Alice' }).locator('[aria-label="Hand raised"]')).toHaveCount(1);

    await a.getByTestId('btn-hand').click();
    await expect(remoteTile(b, 'Alice')).not.toHaveClass(/hand/);

    await a.getByTestId('btn-react').click();
    await a.getByTestId('react-menu').getByRole('button', { name: 'React with 🎉' }).click();
    await expect(b.locator('[data-testid="reaction"]')).toContainText('🎉');
    await expect(b.locator('[data-testid="reaction"]')).toContainText('Alice');
    await expect(a.locator('[data-testid="reaction"]')).toContainText('You');
  });

  test('screen sharing replaces video and can be stopped', async ({ browser }) => {
    const a = await newUser(browser);
    // Instrument peer connections and screen capture so the test can see which track is being sent.
    await a.addInitScript(() => {
      if (!navigator.mediaDevices) return; // e.g. about:blank
      const pcs = [];
      let screen = null;
      const PC = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends PC {
        constructor(...args) {
          super(...args);
          pcs.push(this);
        }
      };
      const gdm = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getDisplayMedia = async (c) => {
        const s = await gdm(c);
        screen = s.getVideoTracks()[0];
        return s;
      };
      window.__sendingScreen = () =>
        Boolean(screen) && pcs.some((pc) => pc.connectionState !== 'closed' && pc.getSenders().some((s) => s.track === screen));
    });
    const code = await createMeeting(a);
    await joinAs(a, 'Alice');
    const b = await newUser(browser);
    await b.goto(`/${code}`);
    await joinAs(b, 'Bob');
    const aliceOnB = remoteTile(b, 'Alice');
    await expectVideoFlowing(aliceOnB);

    await a.getByTestId('btn-screen').click();
    await expect(a.getByTestId('btn-screen')).toHaveClass(/active/);
    await expect(aliceOnB).toHaveClass(/presenting/);
    await expect(aliceOnB).toContainText('Alice (Presenting)');
    await expect(b.getByTestId('toasts')).toContainText('Alice is presenting');
    await expect(a.locator('[data-testid="tile"].self')).toContainText('You are presenting');
    // A static headless screen emits very few frames, so verify the sender switched tracks instead of counting frames.
    await expect.poll(() => a.evaluate(() => window.__sendingScreen())).toBe(true);
    await expect.poll(() => aliceOnB.locator('video').evaluate((v) => v.videoWidth)).toBeGreaterThan(0);

    await a.getByTestId('btn-screen').click();
    await expect(aliceOnB).not.toHaveClass(/presenting/);
    expect(await a.evaluate(() => window.__sendingScreen())).toBe(false);
    await expectVideoFlowing(aliceOnB);
  });

  test('meeting details shows and copies the link', async ({ browser }) => {
    const { code, pages: [a] } = await startMeeting(browser, ['Alice']);
    await a.getByTestId('btn-info').click();
    await expect(a.getByTestId('info-link')).toHaveText(new RegExp(`/${code}$`));
    await a.getByTestId('copy-link').click();
    await expect(a.getByTestId('toasts')).toContainText('Copied meeting link');
    expect(await a.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`/${code}$`));
  });

  test('leaving updates everyone and rejoining reconnects media', async ({ browser }) => {
    const { pages: [a, b] } = await startMeeting(browser, ['Alice', 'Bob']);
    await b.getByTestId('btn-leave').click();
    await expect(b.getByTestId('left-title')).toHaveText('You left the meeting');
    await expect(a.getByTestId('tile')).toHaveCount(1);
    await expect(a.getByTestId('toasts')).toContainText('Bob left');

    await b.getByTestId('rejoin').click();
    await b.getByTestId('join-now').click();
    await expect(b.getByTestId('tile')).toHaveCount(2);
    await expectVideoFlowing(remoteTile(a, 'Bob'));
    await expectVideoFlowing(remoteTile(b, 'Alice'));

    await b.getByTestId('btn-leave').click();
    await b.getByTestId('home-btn').click();
    await expect(b.getByTestId('new-meeting')).toBeVisible();
    await expect(b).toHaveURL(/\/$/);
  });

  test('closing the tab removes the participant', async ({ browser }) => {
    const { pages: [a, b] } = await startMeeting(browser, ['Alice', 'Bob']);
    await b.context().close();
    await expect(a.getByTestId('tile')).toHaveCount(1);
  });
});
