import { defineConfig } from '@playwright/test';

// e2e runs against the ZERO-SPEND demo server (mock fal + fake LLM + isolated env root) — the
// whole money path is exercised without keys, network, or spend.
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1, // the demo server is one shared stateful world — serialize specs
  use: {
    baseURL: 'http://127.0.0.1:5178',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node ../server/dev/demo.js',
    url: 'http://127.0.0.1:5178/__demo/health',
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
    timeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
