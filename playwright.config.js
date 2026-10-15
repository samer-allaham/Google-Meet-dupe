import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT) || 3123;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Uses the locally installed Chrome; set PW_CHANNEL=chromium after `npx playwright install chromium` instead.
    channel: process.env.PW_CHANNEL || 'chrome',
    headless: process.env.HEADED ? false : true,
    permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'],
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--auto-select-desktop-capture-source=Entire screen',
        ...(process.env.STRICT_AUTOPLAY ? [] : ['--autoplay-policy=no-user-gesture-required']),
      ],
    },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node server/index.js',
    url: `http://localhost:${PORT}/healthz`,
    env: { PORT: String(PORT), ICE_SERVERS: '[]' },
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
