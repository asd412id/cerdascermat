import { defineConfig } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';

// Kredensial owner TIDAK disimpan di repo. Untuk lokal, ambil dari `.dev.vars`
// (gitignored) yang juga dibaca `wrangler dev`; di CI sediakan lewat environment.
if (existsSync('.dev.vars')) {
  for (const line of readFileSync('.dev.vars', 'utf8').split(/\r?\n/)) {
    if (!line.includes('=') || line.trim().startsWith('#')) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    process.env[key] ??= line.slice(index + 1).trim();
  }
}

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    channel: 'msedge',
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'msedge', use: { browserName: 'chromium', channel: 'msedge' } }],
  webServer: [
    {
      command: 'npm run dev:api',
      url: 'http://localhost:8787/api/health',
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: 'npm run build:e2e && npm run preview',
      url: 'http://localhost:4173',
      reuseExistingServer: true,
      timeout: 180_000,
    },
  ],
});
