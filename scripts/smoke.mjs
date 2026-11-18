/**
 * Smoke realtime tanpa browser: login admin → buat lomba → 3 tim join →
 * buka ronde → tekan → verifikasi ranking → reset → skor manual.
 * Pakai: node scripts/smoke.mjs [http://localhost:8787]
 */
const BASE = (process.argv[2] ?? 'http://localhost:8787').replace(/\/$/, '');
const WS_BASE = BASE.replace(/^http/, 'ws');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(path, init = {}, token) {
  const headers = { 'content-type': 'application/json', ...(init.headers ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${BASE}${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} → ${response.status} ${JSON.stringify(body)}`);
  return body;
}

function connect(code, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws/event/${code}`);
    const inbox = [];
    const waiters = [];
    ws.addEventListener('open', () => ws.send(JSON.stringify(hello)));
    ws.addEventListener('error', () => reject(new Error('ws error')));
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const index = waiters.findIndex((waiter) => waiter.match(message));
      if (index >= 0) {
        const [waiter] = waiters.splice(index, 1);
        waiter.resolve(message);
      } else {
        inbox.push(message);
      }
    });
    const waitFor = (match, timeoutMs = 10_000) =>
      new Promise((res, rej) => {
        const found = inbox.findIndex(match);
        if (found >= 0) return res(inbox.splice(found, 1)[0]);
        const entry = { match, resolve: res };
        waiters.push(entry);
        setTimeout(() => rej(new Error('timeout menunggu pesan')), timeoutMs);
      });
    resolve({ ws, waitFor, send: (message) => ws.send(JSON.stringify(message)), inbox });
  });
}

const run = async () => {
  const health = await api('/api/health');
  console.log('health', health);

  if (!process.env.OWNER_USERNAME || !process.env.OWNER_PASSWORD) {
    throw new Error('OWNER_USERNAME dan OWNER_PASSWORD wajib diisi di environment (lihat .dev.vars).');
  }
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: process.env.OWNER_USERNAME, password: process.env.OWNER_PASSWORD }),
  });
  const token = login.token;
  console.log('login ok', login.admin.username, login.admin.role);

  const created = await api('/api/events', { method: 'POST', body: JSON.stringify({ name: `Smoke ${Date.now()}` }) }, token);
  const { id: eventId, code } = created.event;
  console.log('event', code, eventId);

  const names = ['Smoke Alfa', 'Smoke Beta', 'Smoke Gama'];
  const teams = [];
  for (const name of names) {
    const joined = await api('/api/join', { method: 'POST', body: JSON.stringify({ code, teamName: name }) });
    teams.push(joined);
  }

  const clients = await Promise.all(
    teams.map((team) =>
      connect(code, { type: 'hello', role: 'team', token: team.token, teamId: team.teamId, appVersion: '1.0.0' }),
    ),
  );
  for (const client of clients) await client.waitFor((m) => m.type === 'hello.ok');
  console.log('3 tim terhubung');

  const opened = await api(`/api/events/${eventId}/action`, { method: 'POST', body: JSON.stringify({ action: 'open_round', payload: {} }) }, token);
  const attempt = opened.attempt;
  for (const client of clients) {
    const message = await client.waitFor((m) => m.type === 'attempt.opened');
    if (message.attemptId !== attempt.id) throw new Error('attempt id tidak konsisten');
  }

  const delay = attempt.openAt - Date.now();
  if (delay > 0) await sleep(delay + 120);
  const deltas = [40, 150, 300];
  await Promise.all(
    clients.map(async (client, index) => {
      await sleep(index * 30);
      const d = deltas[index];
      client.send({ type: 'press', attemptId: attempt.id, nonce: attempt.nonce, d, u: 4 });
    }),
  );

  const ranked = await clients[0].waitFor((m) => m.type === 'attempt.ranked');
  console.log(
    'ranking',
    ranked.ranking.map((r) => `${r.rank}.${r.name} ${r.dNorm}ms`),
    ranked.tie ? 'SERI' : 'tidak seri',
  );
  if (ranked.ranking[0]?.teamId !== teams[0].teamId) throw new Error('pemenang tidak sesuai harapan');

  const reset = await api(`/api/events/${eventId}/action`, { method: 'POST', body: JSON.stringify({ action: 'reset_buzzer', payload: {} }) }, token);
  if (reset.attempt.id === attempt.id) throw new Error('reset tidak membuat attempt baru');
  const reopened = await clients[1].waitFor((m) => m.type === 'attempt.opened');
  console.log('reset ok → attempt', reopened.attemptId);
  await sleep(Math.max(0, (reopened.openAt ?? Date.now()) - Date.now()) + 150);
  clients[1].send({ type: 'press', attemptId: reopened.attemptId, nonce: reopened.nonce, d: 70, u: 4 });
  await sleep(40);
  clients[0].send({ type: 'press', attemptId: reopened.attemptId, nonce: reopened.nonce, d: 110, u: 4 });
  await sleep(40);
  clients[2].send({ type: 'press', attemptId: reopened.attemptId, nonce: reopened.nonce, d: 160, u: 4 });
  const second = await clients[1].waitFor((m) => m.type === 'attempt.ranked' && m.attemptId === reopened.attemptId);
  if (second.ranking[0]?.teamId !== teams[1].teamId) throw new Error('pemenang attempt kedua salah');

  await api(
    `/api/events/${eventId}/action`,
    { method: 'POST', body: JSON.stringify({ action: 'score_edit', payload: { teamId: teams[1].teamId, delta: 25, reason: 'smoke test' } }) },
    token,
  );
  const snapshot = await api(`/api/events/${eventId}/state`, {}, token);
  const scored = snapshot.snapshot.teams.find((t) => t.id === teams[1].teamId);
  if (scored.score !== 25) throw new Error(`skor manual gagal: ${scored.score}`);

  const csv = await fetch(`${BASE}/api/events/${eventId}/export.csv`, { headers: { authorization: `Bearer ${token}` } });
  if (!csv.ok) throw new Error('ekspor CSV gagal');
  const csvText = await csv.text();
  if (!csvText.includes('Smoke Beta')) throw new Error('CSV tidak memuat tim');

  // aksi admin lanjutan: ubah pemenang, lempar giliran, batalkan ronde, mode, status, audit
  const winner = await api(
    `/api/events/${eventId}/action`,
    { method: 'POST', body: JSON.stringify({ action: 'set_winner', payload: { teamId: teams[0].teamId } }) },
    token,
  );
  if (winner.teamId !== teams[0].teamId || winner.candidateIdx !== 1) throw new Error('ubah pemenang gagal');

  const thrown = await api(`/api/events/${eventId}/action`, { method: 'POST', body: JSON.stringify({ action: 'next_candidate', payload: {} }) }, token);
  if (thrown.candidateIdx !== 2 || thrown.teamId !== teams[2].teamId) throw new Error('lempar giliran gagal');

  const voided = await api(
    `/api/events/${eventId}/action`,
    { method: 'POST', body: JSON.stringify({ action: 'void_round', payload: { reason: 'smoke' } }) },
    token,
  );
  if (voided.round?.status !== 'void') throw new Error('batalkan ronde gagal');

  const mode = await api(
    `/api/events/${eventId}/action`,
    { method: 'POST', body: JSON.stringify({ action: 'set_display_mode', payload: { mode: 'all' } }) },
    token,
  );
  if (mode.event?.displayMode !== 'all') throw new Error('ubah mode tampilan gagal');

  const closed = await api(
    `/api/events/${eventId}/action`,
    { method: 'POST', body: JSON.stringify({ action: 'set_status', payload: { status: 'closed' } }) },
    token,
  );
  if (closed.event?.status !== 'closed') throw new Error('tutup pendaftaran gagal');

  const audited = await api(`/api/events/${eventId}/state`, {}, token);
  const actions = audited.snapshot.audit.map((entry) => entry.action);
  for (const required of ['set_winner', 'next_candidate', 'void_round', 'set_display_mode', 'set_status', 'score_edit']) {
    if (!actions.includes(required)) throw new Error(`audit tidak memuat ${required}`);
  }

  for (const client of clients) client.ws.close();
  console.log('SMOKE OK: join, sync, press, rank, reset, skor manual, CSV, ubah pemenang, lempar, batal, mode, status, audit');
};

run().catch((error) => {
  console.error('SMOKE GAGAL:', error);
  process.exit(1);
});
