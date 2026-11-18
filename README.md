# Cerdas Cermat — Rebutan

Aplikasi rebutan (buzzer) cerdas cermat: peserta menekan tombol di HP, wasit waktu di Cloudflare Worker menentukan urutan tekan, operator memberi poin. Papan skor dan halaman keadilan bisa ditampilkan ke penonton.

- SPA: React + Vite + TypeScript + Tailwind, dipasang sebagai PWA.
- API & realtime: Cloudflare Worker (Hono) + satu Durable Object `EventDO` per lomba, satu `PlatformDO` untuk admin dan registry lomba.
- Penilaian tekan memakai jam tersinkron (NTP-style), bukan waktu paket tiba.

## Struktur

| Path | Isi |
| --- | --- |
| `worker/index.ts` | Router HTTP, CORS/Origin, websocket upgrade. |
| `worker/platform.ts` | `PlatformDO`: admin, sesi, registry lomba. |
| `worker/event.ts` | `EventDO`: tim, attempt, ranking, aksi admin, audit. |
| `shared/rank.ts` | Normalisasi klaim tekan dan pemeringkatan. |
| `src/pages/*` | `Join`, `Team`, `Admin`, `Screen`, `Fairness`. |
| `db/*.sql` | Skema SQLite untuk kedua Durable Object. |
| `scripts/smoke.mjs` | Uji realtime tanpa browser (login → join → tekan → reset → skor → CSV). |
| `tests/flow.spec.ts` | E2E Playwright (Edge): alur lomba, screenshot, CORS/auth. |

## Prasyarat

Node 22+ dan npm. Untuk E2E dipakai Microsoft Edge (`channel: msedge`).

```bash
npm install
```

## Menjalankan lokal

1. Buat `.dev.vars` (sudah di-`.gitignore`, jangan di-commit):

   ```
   OWNER_USERNAME=owner
   OWNER_PASSWORD=sandi-lokal-kuat
   ```

   Owner diseed otomatis saat `PlatformDO` pertama kali dipakai. Ganti sandi sebelum dipakai di jaringan nyata.

2. Jalankan API dan SPA di dua terminal:

   ```bash
   npm run dev:api   # http://localhost:8787
   npm run dev:web   # http://localhost:5173
   ```

3. Cek `http://localhost:8787/api/health`.

Uji E2E dan `scripts/smoke.mjs` memakai `OWNER_USERNAME`/`OWNER_PASSWORD` dari `.dev.vars`
(atau environment). Tidak ada sandi yang disimpan di repo, jadi uji akan berhenti dengan
pesan jelas bila kredensial lokal belum disiapkan.

## Konfigurasi

Worker (`wrangler.jsonc` untuk lokal, `wrangler secret put` untuk produksi):

| Variabel | Arti |
| --- | --- |
| `OWNER_USERNAME`, `OWNER_PASSWORD` | Akun owner yang diseed. Simpan sebagai secret. |
| `ALLOWED_ORIGINS` | Daftar origin dipisah koma, tanpa spasi. Dipakai untuk CORS **dan** cek Origin websocket. |
| `ALLOW_ADMIN_SIGNUP` | `true` hanya bila pendaftaran operator mandiri memang diinginkan. |
| `SESSION_TTL_HOURS` | Umur token admin (default 12). |
| `LEAD_MS` | Jeda tombol menyala setelah operator menekan buka (default 900). |
| `DECISION_MS` | Jendela tunggu setelah tekan pertama agar paket tidak berurutan (default 220). |
| `TIE_MS` | Ambang tambahan penanda seri teknis (default 15). |
| `READY_MAX_U_MS` | Batas `u` agar tim dianggap siap (default 150). |

SPA: `VITE_API_BASE` (origin Worker, tanpa garis miring di akhir). Lihat `.env.example`.

## Alur lomba

1. Operator masuk di `/admin`, membuat lomba, lalu membagikan kode 6 karakter.
2. Tim membuka `/`, mengisi kode dan nama tim. Satu tim = satu token perangkat.
3. Panel **Kesiapan** menampilkan tim yang socket-nya hidup, jamnya baru disinkronkan (< 20 detik), dan `u ≤ READY_MAX_U_MS`.
4. **Buka rebutan** mengirim waktu buka absolut `LEAD_MS` ke depan; tombol peserta menyala otomatis. Bila ada tim belum siap, gunakan **buka paksa** — tercatat di audit.
5. Setelah tekan: **Beri poin** untuk kandidat aktif, **Tidak bisa → lempar** untuk memindah kandidat, **Reset tombol** untuk percobaan baru pada ronde yang sama, **Batalkan ronde** untuk membatalkan.
6. Seri teknis tidak diputus diam-diam: operator melihat kandidat dan memilih ulang atau mengulang ronde.
7. **Skor manual** mencatat `delta` dan alasan ke audit. **CSV** mengekspor attempt dan skor untuk arsip.

## Keadilan waktu

- Perangkat menukar 7 sampel waktu; offset memakai sampel dengan RTT terkecil dan `u = RTT/2` dipakai server sebagai pagar kewajaran klaim (tidak ditampilkan ke peserta).
- Klaim tekan memakai `performance.now()` pada `pointerdown`, bukan waktu terima paket.
- Server memeriksa kewajaran klaim dan menandai anomali (`flags`) alih-alih menolak tanpa jejak.
- Jeda `DECISION_MS` menyerap paket yang tiba tidak berurutan; `TIE_MS` menandai selisih yang berada di dalam ketidakpastian.

## Uji

```bash
npm run typecheck        # SPA + Worker
npm test                 # Vitest (uji ranking)
node scripts/smoke.mjs   # butuh `npm run dev:api` aktif
npm run test:e2e         # Playwright + Edge, menyalakan wrangler & preview sendiri
```

E2E menyimpan screenshot di `test-results/screens/` (admin 1440/768/390, tim 390/768, papan skor 1920, join, keadilan) dan memeriksa tidak ada overflow horizontal di 390 px.

## Deploy

Produksi saat ini:

| Bagian | URL |
|---|---|
| Aplikasi peserta/admin/papan skor | https://cerdas-cermat-2026.web.app |
| API + WebSocket | https://cerdascermat-api.asdar-binsyam.workers.dev |
| Firebase project | `cerdas-cermat-2026` (`.firebaserc`) |

API:

```bash
npx wrangler login
set -a; . ./.dev.vars; set +a   # OWNER_USERNAME, OWNER_PASSWORD
printf '%s' "$OWNER_USERNAME" | npx wrangler secret put OWNER_USERNAME
printf '%s' "$OWNER_PASSWORD" | npx wrangler secret put OWNER_PASSWORD
npx wrangler deploy
```

`ALLOWED_ORIGINS` diisi di `wrangler.jsonc` (localhost + `https://cerdas-cermat-2026.web.app` + `https://cerdas-cermat-2026.firebaseapp.com`). `workers_dev: true` wajib ada, kalau tidak rute `*.workers.dev` mati dan URL menghasilkan galat 1042.

`wrangler.jsonc` sudah memuat migrasi `new_sqlite_classes` untuk kedua DO. Jangan mengubah nama kelas/binding tanpa migrasi baru.

Web:

```bash
VITE_API_BASE=https://cerdascermat-api.asdar-binsyam.workers.dev npm run build
npx firebase-tools deploy --only hosting
```

`firebase.json` mengatur rewrite SPA, header cache (`/`, `/index.html`, `sw.js` selalu `no-cache`), CSP, dan `X-Frame-Options`.

Verifikasi setelah deploy:

```bash
node scripts/prod-check.mjs                      # SPA + CORS + login admin di browser Edge
node scripts/smoke.mjs https://cerdascermat-api.asdar-binsyam.workers.dev
```

`prod-check.mjs` tidak menulis data; `smoke.mjs` membuat satu lomba uji beserta 3 tim di produksi.

## Operasional & batasan

- Data lomba hidup di SQLite milik `EventDO`. Arsipkan lewat CSV sebelum menghapus lomba; tidak ada backup otomatis lintas akun.
- Satu perangkat hanya boleh mewakili satu tim. Token tim disimpan di `localStorage`; "Keluar tim" menghapus sesi perangkat.
- Service worker hanya meng-cache aset SPA. Saat API mati, halaman tetap terbuka tetapi menampilkan status terputus dan tombol tidak dinilai.
- Bila peserta melaporkan tombolnya tidak menyala, lihat panel **Kesiapan** di admin: tim berstatus “belum siap” berarti socket, sinkronisasi jam, atau `u`-nya belum memenuhi ambang. Periksa `ALLOWED_ORIGINS`, jam perangkat, dan kualitas jaringan. UI sengaja tidak menampilkan angka diagnostik.
- 403 pada `/api/health` berarti `Origin` pemanggil tidak ada di `ALLOWED_ORIGINS`.
