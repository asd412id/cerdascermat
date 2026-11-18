import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// Kredensial lokal tidak disimpan di repo: `playwright.config.ts` membacanya dari
// `.dev.vars` (gitignored) atau environment saat E2E dijalankan.
const OWNER = {
  username: process.env.OWNER_USERNAME ?? '',
  password: process.env.OWNER_PASSWORD ?? '',
};
if (!OWNER.username || !OWNER.password) {
  throw new Error('OWNER_USERNAME & OWNER_PASSWORD wajib tersedia lewat .dev.vars atau environment untuk E2E.');
}
const SHOTS = 'test-results/screens';

async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${label} tidak boleh melebar horizontal`).toBeLessThanOrEqual(1);
}

async function loginWith(page: Page, credentials: { username: string; password: string }): Promise<void> {
  await page.goto('/admin');
  await page.getByLabel('Nama pengguna').fill(credentials.username);
  await page.getByLabel('Sandi', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Masuk' }).click();
  await expect(page.getByText('Pilih lomba')).toBeVisible();
}

async function login(page: Page): Promise<void> {
  await loginWith(page, OWNER);
}

async function joinTeam(page: Page, code: string, name: string): Promise<void> {
  await page.goto(`/?code=${code}`);
  await page.getByLabel('Nama tim').fill(name);
  await page.getByRole('button', { name: 'Daftar & masuk' }).click();
  await expect(page.getByTestId('buzzer')).toBeVisible();
  await expect(page.locator('header')).toContainText(name);
}

async function pressAt(page: Page, delayMs: number): Promise<void> {
  await page.waitForTimeout(delayMs);
  await page.getByTestId('buzzer').dispatchEvent('pointerdown', { bubbles: true });
}

test('alur lomba: daftar, rebutan, reset, mode tampilan', async ({ browser, page }) => {
  mkdirSync(SHOTS, { recursive: true });

  await login(page);

  const eventName = `Uji ${Date.now().toString().slice(-6)}`;
  await page.getByPlaceholder('Cerdas Cermat Kecamatan 2026').fill(eventName);
  await page.getByRole('button', { name: 'Buat' }).click();
  const notice = page.getByRole('status').first();
  await expect(notice).toContainText('Kode join');
  const noticeText = (await notice.textContent()) ?? '';
  const code = /([A-Z0-9]{6})/.exec(noticeText)?.[1];
  expect(code, 'kode join muncul').toBeTruthy();
  if (!code) throw new Error('kode join tidak ditemukan');

  const names = ['Tim Alfa', 'Tim Beta', 'Tim Gama'];
  const contexts = await Promise.all(names.map(() => browser.newContext({ viewport: { width: 390, height: 844 } })));
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  for (let i = 0; i < pages.length; i += 1) await joinTeam(pages[i], code, names[i]);
  await expect(page.getByText('3 tim · 3 online', { exact: true })).toBeVisible({ timeout: 20_000 });

  // sebelum lomba dimulai: kontrol ronde terkunci, hapus lomba masih terbuka
  await expect(page.getByRole('button', { name: 'Buka rebutan' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Reset tombol' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Batalkan ronde' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Hapus', exact: true })).toBeEnabled();

  await page.getByRole('button', { name: 'Mulai lomba' }).click();
  await expect(page.getByRole('status').first()).toContainText('Lomba dimulai');
  await expect(page.getByRole('button', { name: 'Buka rebutan' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Hapus', exact: true })).toBeDisabled();

  await page.getByRole('button', { name: 'Buka rebutan' }).click();

  await Promise.all(pages.map((teamPage) => expect(teamPage.getByTestId('buzzer')).toHaveAttribute('data-phase', 'live', { timeout: 15_000 })));
  await Promise.all([pressAt(pages[0], 0), pressAt(pages[1], 45), pressAt(pages[2], 90)]);

  const ranking = page.getByTestId('ranking');
  await expect(ranking).toBeVisible({ timeout: 15_000 });
  await expect(ranking.locator('tbody tr').first()).toContainText('Tim Alfa');
  await expect(ranking.locator('tbody tr')).toHaveCount(3);
  await expect(pages[0].getByTestId('buzzer')).toContainText('TERCEPAT');

  await page.screenshot({ path: `${SHOTS}/admin-1440.png`, fullPage: true });
  await expectNoHorizontalOverflow(page, 'admin 1440');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: `${SHOTS}/admin-1280.png`, fullPage: true });
  await expectNoHorizontalOverflow(page, 'admin 1280');
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.screenshot({ path: `${SHOTS}/admin-768.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${SHOTS}/admin-390.png`, fullPage: true });
  await expectNoHorizontalOverflow(page, 'admin 390');
  await page.setViewportSize({ width: 1440, height: 900 });

  await pages[0].screenshot({ path: `${SHOTS}/team-390.png`, fullPage: false });
  await pages[1].setViewportSize({ width: 768, height: 1024 });
  await pages[1].screenshot({ path: `${SHOTS}/team-768.png`, fullPage: false });

  // reset tombol: attempt baru pada ronde yang sama, tim lain bisa menang
  await page.getByRole('button', { name: 'Reset tombol' }).click();
  await Promise.all(pages.map((teamPage) => expect(teamPage.getByTestId('buzzer')).toHaveAttribute('data-phase', 'live', { timeout: 15_000 })));
  await Promise.all([pressAt(pages[1], 0), pressAt(pages[0], 60), pressAt(pages[2], 120)]);
  await expect(page.getByTestId('ranking').locator('tbody tr').first()).toContainText('Tim Beta', { timeout: 15_000 });

  // beri poin ke kandidat aktif lalu pastikan skor berubah
  await page.getByRole('button', { name: /Beri poin \+100/ }).click();
  await expect(page.locator('section').filter({ hasText: 'Tim & skor' })).toContainText('100', { timeout: 10_000 });

  // mode tampilan: "hanya tercepat" menyisakan satu baris urutan tekan, "semua urutan" menampilkan semuanya
  await expect(pages[0].locator('ol li')).toHaveCount(1, { timeout: 15_000 });
  await page.getByRole('button', { name: 'semua urutan' }).click();
  await expect(pages[0].locator('ol li')).toHaveCount(3, { timeout: 15_000 });
  const screen = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await screen.goto(`/screen?code=${code}`);
  await expect(screen.getByText('Klasemen')).toBeVisible({ timeout: 15_000 });
  await expect(screen.getByText('urutan tekan')).toBeVisible();
  await expect(screen.locator('ol li')).toHaveCount(3);
  await screen.screenshot({ path: `${SHOTS}/screen-1920.png`, fullPage: false });

  const joinShot = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await joinShot.goto('/');
  await joinShot.screenshot({ path: `${SHOTS}/join-1440.png`, fullPage: false });
  await joinShot.setViewportSize({ width: 768, height: 1024 });
  await joinShot.screenshot({ path: `${SHOTS}/join-768.png`, fullPage: false });
  await joinShot.setViewportSize({ width: 390, height: 844 });
  await joinShot.screenshot({ path: `${SHOTS}/join-390.png`, fullPage: false });
  await expectNoHorizontalOverflow(joinShot, 'join 390');

  // halaman keadilan ikut diuji karena memuat aturan seri dan batas perangkat
  const fairness = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await fairness.goto('/keadilan');
  await expect(fairness.getByRole('heading', { name: 'Cara menentukan penekan tercepat' })).toBeVisible({ timeout: 15_000 });
  await fairness.screenshot({ path: `${SHOTS}/fairness-390.png`, fullPage: true });
  await expectNoHorizontalOverflow(fairness, 'keadilan 390');
  await fairness.setViewportSize({ width: 1440, height: 900 });
  await fairness.screenshot({ path: `${SHOTS}/fairness-1440.png`, fullPage: true });

  await Promise.all(contexts.map((context) => context.close()));
  await screen.close();
  await joinShot.close();
  await fairness.close();
});

test('akun admin: ganti nama pengguna dan sandi sendiri', async ({ browser, page }) => {
  const stamp = Date.now().toString().slice(-5);
  const operator = { username: `ops${stamp}`, password: 'sandiops1' };
  const renamed = { username: `opsb${stamp}`, password: 'sandiops2' };

  await login(page);

  // owner menambah operator uji
  await page.getByRole('button', { name: 'kelola' }).click();
  await page.getByPlaceholder('nama pengguna baru').fill(operator.username);
  await page.getByPlaceholder('sandi minimal 8 karakter').fill(operator.password);
  await page.getByRole('button', { name: 'tambah' }).click();
  await expect(page.getByRole('status').first()).toContainText('Admin ditambahkan');

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const opPage = await context.newPage();
  await loginWith(opPage, operator);

  // operator mengganti nama pengguna dan sandinya sendiri
  const accountPanel = opPage.locator('section').filter({ hasText: 'Akun saya' });
  await accountPanel.getByRole('button', { name: 'ubah' }).click();
  // tombol intip sandi memakai ikon, bukan teks
  const currentPassword = accountPanel.getByLabel('sandi saat ini');
  await expect(currentPassword).toHaveAttribute('type', 'password');
  await accountPanel.getByRole('button', { name: 'Tampilkan sandi' }).first().click();
  await expect(currentPassword).toHaveAttribute('type', 'text');
  await accountPanel.getByRole('button', { name: 'Sembunyikan sandi' }).first().click();
  await expect(currentPassword).toHaveAttribute('type', 'password');
  await accountPanel.screenshot({ path: `${SHOTS}/admin-akun-ikon.png` });
  await accountPanel.getByLabel('nama pengguna').fill(renamed.username);
  await accountPanel.getByLabel('sandi saat ini').fill(operator.password);
  await accountPanel.getByLabel('sandi baru').fill(renamed.password);
  await accountPanel.getByRole('button', { name: 'simpan' }).click();
  await expect(opPage.getByRole('status').first()).toContainText('diperbarui');
  await expect(opPage.locator('header').first()).toContainText(renamed.username);

  // sandi lama tidak berlaku lagi, sandi baru bisa masuk
  await opPage.getByRole('button', { name: 'Keluar', exact: true }).click();
  await loginWith(opPage, renamed);
  await expect(opPage.locator('header').first()).toContainText(renamed.username);

  // bersihkan admin uji lewat owner
  await page.locator('li').filter({ hasText: operator.username }).getByRole('button', { name: 'hapus' }).click();
  await expect(page.locator('li').filter({ hasText: operator.username })).toHaveCount(0, { timeout: 10_000 });

  await context.close();
});

test('lobi: QR di layar, daftar peserta, keluarkan, mulai lomba, hapus lomba', async ({ browser, page }) => {
  mkdirSync(SHOTS, { recursive: true });
  await login(page);

  const eventName = `Lobi ${Date.now().toString().slice(-6)}`;
  await page.getByPlaceholder('Cerdas Cermat Kecamatan 2026').fill(eventName);
  await page.getByRole('button', { name: 'Buat' }).click();
  const notice = page.getByRole('status').first();
  await expect(notice).toContainText('Kode join');
  const code = /([A-Z0-9]{6})/.exec((await notice.textContent()) ?? '')?.[1];
  if (!code) throw new Error('kode join tidak ditemukan');

  // layar menampilkan kode dan QR untuk dipindai peserta
  const screen = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await screen.goto(`/screen?code=${code}`);
  await expect(screen.getByText('pindai untuk daftar')).toBeVisible({ timeout: 15_000 });
  await expect(screen.getByAltText(new RegExp(`Kode QR pendaftaran .*${code}`))).toBeVisible({ timeout: 15_000 });
  await expect(screen.getByText(new RegExp(`/\\?code=${code}`))).toBeVisible();
  await screen.screenshot({ path: `${SHOTS}/lobby-1440.png`, fullPage: false });

  // dua tim mendaftar memakai tautan yang sama dengan QR
  const names = ['Tim Satu', 'Tim Dua'];
  const contexts = await Promise.all(names.map(() => browser.newContext({ viewport: { width: 390, height: 844 } })));
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  for (let i = 0; i < pages.length; i += 1) await joinTeam(pages[i], code, names[i]);
  await expect(screen.getByText('Tim Satu')).toBeVisible({ timeout: 15_000 });
  await expect(screen.getByText('Tim Dua')).toBeVisible();
  await expect(page.getByText('2 tim · 2 online', { exact: true })).toBeVisible({ timeout: 20_000 });

  // keluarkan peserta sebelum lomba dimulai
  await page.locator('tr').filter({ hasText: 'Tim Dua' }).getByRole('button', { name: 'keluarkan' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Ya, keluarkan' }).click();
  await expect(page.locator('tr').filter({ hasText: 'Tim Dua' })).toHaveCount(0, { timeout: 10_000 });
  await expect(pages[1].getByLabel('Nama tim')).toBeVisible({ timeout: 20_000 });

  // tombol mulai menutup pendaftaran dan layar pindah ke klasemen
  await page.getByRole('button', { name: 'Mulai lomba' }).click();
  await expect(page.getByRole('status').first()).toContainText('Pendaftaran ditutup');
  await expect(screen.getByText('Klasemen')).toBeVisible({ timeout: 15_000 });

  const late = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await late.goto(`/?code=${code}`);
  await expect(late.getByText('Pendaftaran lomba ini sudah ditutup.')).toBeVisible({ timeout: 15_000 });
  await expect(late.getByRole('button', { name: 'Daftar & masuk' })).toBeDisabled();

  // lomba berjalan: hapus terkunci dan layar tidak menampilkan QR pendaftaran
  await expect(page.getByRole('button', { name: 'Hapus', exact: true })).toBeDisabled();
  await expect(screen.getByText('pindai untuk daftar')).toHaveCount(0);

  // pendaftaran dibuka lagi: status kembali belum berjalan, QR tampil lagi di layar
  await page.getByRole('button', { name: 'Buka pendaftaran' }).click();
  await expect(page.getByRole('button', { name: 'Hapus', exact: true })).toBeEnabled();
  await expect(screen.getByText('pindai untuk daftar')).toBeVisible({ timeout: 15_000 });

  // hapus lomba beserta data terkait
  await page.getByRole('button', { name: 'Hapus', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Hapus lomba' }).click();
  await expect(page.getByRole('status').first()).toContainText('dihapus');
  await expect(page.getByRole('option', { name: new RegExp(eventName) })).toHaveCount(0, { timeout: 10_000 });

  // kode lomba yang sudah dihapus tidak boleh membuat papan skor memuat selamanya
  const gone = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await gone.goto(`/screen?code=${code}`);
  await expect(gone.getByText('Lomba tidak tersedia')).toBeVisible({ timeout: 15_000 });
  await expect(gone.getByText(`Kode ${code} tidak ditemukan`)).toBeVisible();
  await expect(gone.getByRole('progressbar')).toHaveCount(0);
  await gone.screenshot({ path: `${SHOTS}/screen-tidak-tersedia.png`, fullPage: false });
  await gone.close();

  await Promise.all(contexts.map((context) => context.close()));
  await screen.close();
  await late.close();
});

test('keluar tim: batal, konfirmasi, masuk kembali, dan nama berbeda', async ({ browser, page }) => {
  mkdirSync(SHOTS, { recursive: true });
  await login(page);

  const eventName = `Keluar ${Date.now().toString().slice(-6)}`;
  await page.getByPlaceholder('Cerdas Cermat Kecamatan 2026').fill(eventName);
  await page.getByRole('button', { name: 'Buat' }).click();
  const notice = page.getByRole('status').first();
  await expect(notice).toContainText('Kode join');
  const code = /([A-Z0-9]{6})/.exec((await notice.textContent()) ?? '')?.[1];
  if (!code) throw new Error('kode join tidak ditemukan');

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const team = await context.newPage();
  await joinTeam(team, code, 'Tim Kembali');

  // batal: tetap di halaman tim
  await team.getByRole('button', { name: 'Keluar tim' }).click();
  const dialog = team.getByRole('dialog');
  await expect(dialog).toContainText('Keluar dari tim?');
  await dialog.getByRole('button', { name: 'Batal' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(team.getByTestId('buzzer')).toBeVisible();

  // konfirmasi keluar: sesi aktif dilepas, tim tersimpan di perangkat
  await team.getByRole('button', { name: 'Keluar tim' }).click();
  await team.getByRole('dialog').getByRole('button', { name: 'Ya, keluar' }).click();
  await expect(team.getByText('Tim tersimpan di perangkat ini')).toBeVisible();
  await expect(team.getByTestId('buzzer')).toHaveCount(0);

  // masuk kembali tanpa token baru
  await team.getByRole('button', { name: 'Masuk kembali' }).click();
  await expect(team.getByTestId('buzzer')).toBeVisible();
  await expect(team.locator('header')).toContainText('Tim Kembali');

  // kode sama + nama berbeda: ditawari masuk sebagai nama lama atau daftar tim baru
  await team.getByRole('button', { name: 'Keluar tim' }).click();
  await team.getByRole('dialog').getByRole('button', { name: 'Ya, keluar' }).click();
  await team.getByLabel('Kode lomba').fill(code);
  await team.getByLabel('Nama tim').fill('Tim Kembali');
  await team.getByRole('button', { name: 'Daftar & masuk' }).click();
  await expect(team.getByRole('dialog')).toContainText('Tim ini sudah terdaftar');
  await team.getByRole('dialog').getByRole('button', { name: 'Masuk sebagai Tim Kembali' }).click();
  await expect(team.getByTestId('buzzer')).toBeVisible();

  await team.getByRole('button', { name: 'Keluar tim' }).click();
  await team.getByRole('dialog').getByRole('button', { name: 'Ya, keluar' }).click();
  await team.getByLabel('Kode lomba').fill(code);
  await team.getByLabel('Nama tim').fill('Tim Kembali Dua');
  await team.getByRole('button', { name: 'Daftar & masuk' }).click();
  await expect(team.getByRole('dialog')).toContainText('sudah terhubung dengan tim');
  await team.getByRole('dialog').getByRole('button', { name: 'Daftar tim baru' }).click();
  await expect(team.getByTestId('buzzer')).toBeVisible();
  await expect(team.locator('header')).toContainText('Tim Kembali Dua');
  await team.screenshot({ path: `${SHOTS}/team-kembali-390.png`, fullPage: false });

  await page.getByRole('button', { name: 'Hapus', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Hapus lomba' }).click();
  await expect(page.getByRole('status').first()).toContainText('dihapus');

  await context.close();
});

test('jam perangkat meleset tidak memengaruhi hasil rebutan', async ({ browser, page }) => {
  await login(page);

  const eventName = `Jam ${Date.now().toString().slice(-6)}`;
  await page.getByPlaceholder('Cerdas Cermat Kecamatan 2026').fill(eventName);
  await page.getByRole('button', { name: 'Buat' }).click();
  const notice = page.getByRole('status').first();
  await expect(notice).toContainText('Kode join');
  const code = /([A-Z0-9]{6})/.exec((await notice.textContent()) ?? '')?.[1];
  if (!code) throw new Error('kode join tidak ditemukan');

  // dua HP dengan jam dinding meleset: +5 jam dan -7 jam dari waktu sebenarnya
  const skews = [5 * 3_600_000, -7 * 3_600_000];
  const names = ['Tim Maju', 'Tim Mundur'];
  const contexts = await Promise.all(skews.map(() => browser.newContext({ viewport: { width: 390, height: 844 } })));
  for (let i = 0; i < contexts.length; i += 1) {
    await contexts[i].addInitScript((skew: number) => {
      const realNow = Date.now.bind(Date);
      Date.now = () => realNow() + skew;
    }, skews[i]);
  }

  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  for (let i = 0; i < pages.length; i += 1) await joinTeam(pages[i], code, names[i]);

  await page.getByRole('button', { name: 'Mulai lomba' }).click();
  await expect(page.getByRole('status').first()).toContainText('Lomba dimulai');
  await page.getByRole('button', { name: 'Buka rebutan' }).click();
  await Promise.all(pages.map((teamPage) => expect(teamPage.getByTestId('buzzer')).toHaveAttribute('data-phase', 'live', { timeout: 15_000 })));
  await Promise.all([pressAt(pages[0], 0), pressAt(pages[1], 120)]);

  const ranking = page.getByTestId('ranking');
  await expect(ranking).toBeVisible({ timeout: 15_000 });
  await expect(ranking.locator('tbody tr')).toHaveCount(2);
  await expect(ranking.locator('tbody tr').first()).toContainText('Tim Maju');
  await expect(pages[0].getByTestId('buzzer')).toContainText('TERCEPAT');

  await Promise.all(contexts.map((context) => context.close()));
});

test('CORS & auth: origin asing ditolak, tanpa bearer 401', async ({ request }) => {
  const health = await request.get('http://localhost:8787/api/health', { headers: { Origin: 'https://jahat.example' } });
  expect(health.status()).toBe(403);

  const allowed = await request.get('http://localhost:8787/api/health', { headers: { Origin: 'http://localhost:4173' } });
  expect(allowed.status()).toBe(200);
  expect(allowed.headers()['access-control-allow-origin']).toBe('http://localhost:4173');

  const preflight = await request.fetch('http://localhost:8787/api/events', {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:4173', 'Access-Control-Request-Method': 'POST' },
  });
  expect(preflight.status()).toBe(204);
  expect(preflight.headers()['access-control-max-age']).toBe('86400');

  const unauthorized = await request.get('http://localhost:8787/api/events');
  expect(unauthorized.status()).toBe(401);
});
