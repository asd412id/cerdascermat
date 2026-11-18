/**
 * Verifikasi produksi tanpa menulis data lomba: buka SPA dari Firebase Hosting,
 * pastikan health lintas-origin lolos, halaman publik tampil, dan login admin berhasil.
 * Pakai: set OWNER_USERNAME & OWNER_PASSWORD, lalu
 *   node scripts/prod-check.mjs [https://cerdas-cermat-2026.web.app]
 */
import { chromium } from '@playwright/test';

const BASE = (process.argv[2] ?? 'https://cerdas-cermat-2026.web.app').replace(/\/$/, '');
const USERNAME = process.env.OWNER_USERNAME;
const PASSWORD = process.env.OWNER_PASSWORD;

if (!USERNAME || !PASSWORD) {
  console.error('OWNER_USERNAME dan OWNER_PASSWORD wajib diisi di environment.');
  process.exit(1);
}

const problems = [];

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

context.on('console', () => undefined);
const watch = (page, label) => {
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`${label} console: ${message.text()}`);
  });
  page.on('requestfailed', (request) => problems.push(`${label} gagal: ${request.url()} (${request.failure()?.errorText ?? ''})`));
  page.on('pageerror', (error) => problems.push(`${label} exception: ${error.message}`));
};

const join = await context.newPage();
watch(join, 'peserta');
await join.goto(BASE, { waitUntil: 'networkidle' });
if (await join.getByRole('heading', { name: 'Lomba belum tersambung' }).count()) throw new Error('health lintas-origin gagal: layar "Lomba belum tersambung" muncul');
await join.getByRole('heading', { name: 'Daftar tim' }).waitFor({ timeout: 20_000 });
console.log('ok  peserta  : health lintas-origin lolos, form pendaftaran tampil');

const admin = await context.newPage();
watch(admin, 'admin');
await admin.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
await admin.getByLabel('Nama pengguna').fill(USERNAME);
// `exact` wajib: tombol "Tampilkan sandi" juga mengandung kata "sandi".
await admin.getByLabel('Sandi', { exact: true }).fill(PASSWORD);
await admin.getByRole('button', { name: 'Masuk' }).click();
await admin.getByRole('heading', { name: 'Pilih lomba' }).waitFor({ timeout: 20_000 });
console.log('ok  admin    : login produksi diterima, dasbor terbuka');

const screen = await context.newPage();
watch(screen, 'papan skor');
await screen.goto(`${BASE}/screen`, { waitUntil: 'networkidle' });
await screen.getByRole('heading', { name: 'Masukkan kode lomba' }).waitFor({ timeout: 20_000 });
console.log('ok  layar    : papan skor meminta kode lomba');

const fairness = await context.newPage();
watch(fairness, 'keadilan');
await fairness.goto(`${BASE}/keadilan`, { waitUntil: 'networkidle' });
await fairness.getByRole('heading', { name: 'Cara menentukan penekan tercepat' }).waitFor({ timeout: 20_000 });
console.log('ok  keadilan : halaman aturan terbuka');

await browser.close();

if (problems.length) {
  console.error('MASALAH:\n' + problems.map((line) => ` - ${line}`).join('\n'));
  process.exit(1);
}
console.log('PROD CHECK OK: SPA, CORS, login admin, papan skor, halaman aturan');
