// Render public/favicon.svg menjadi PNG ikon PWA/favicon.
// Dipakai supaya semua ukuran berasal dari satu sumber vektor yang sama.
// Jalankan: node scripts/build-icons.mjs
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const svg = readFileSync(`${root}public/favicon.svg`, 'utf8');
const master = `${root}public/icon-master.png`;

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
await page.setContent(
  `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:#100E0C}svg{display:block;width:1024px;height:1024px}</style></head><body>${svg}</body></html>`,
);
await page.screenshot({ path: master });
await browser.close();

const sizes = [
  ['icon-1024.png', 1024],
  ['icon-512.png', 512],
  ['icon-192.png', 192],
  ['apple-touch-icon.png', 180],
  ['favicon-48.png', 48],
  ['favicon-32.png', 32],
];

for (const [name, size] of sizes) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', master, '-vf', `scale=${size}:${size}:flags=lanczos`, '-frames:v', '1', `${root}public/${name}`]);
  console.log(`${name} ${size}x${size}`);
}

rmSync(master);
