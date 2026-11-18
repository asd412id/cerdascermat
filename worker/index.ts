import { Hono } from 'hono';
import { APP_VERSION, type EventMeta, type Snapshot } from '@shared/protocol';
import type { AdminSession, Env } from './env';
import { normalizeCode, sha256Hex } from './auth';

type Bindings = Env;
type Variables = { origin: string | undefined };

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function isAllowedOrigin(env: Env, origin: string | undefined): boolean {
  if (!origin) return true;
  const list = allowedOrigins(env);
  if (list.length === 0) return true;
  return list.includes(origin.replace(/\/$/, ''));
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  return {
    'access-control-allow-origin': origin ?? '*',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

// CORS: allowlist eksplisit, bukan '*'. Preflight dijawab Worker.
app.use('/api/*', async (c, next) => {
  const origin = c.req.header('origin');
  if (!isAllowedOrigin(c.env, origin)) return c.json({ error: 'origin_not_allowed' }, 403);
  if (c.req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  await next();
  for (const [key, value] of Object.entries(corsHeaders(origin))) c.res.headers.set(key, value);
});

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    version: APP_VERSION,
    serverTime: Date.now(),
    origins: allowedOrigins(c.env).length,
  }),
);

function platformStub(env: Env) {
  return env.PLATFORM.get(env.PLATFORM.idFromName('platform'));
}

async function platformJson<T>(env: Env, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await platformStub(env).fetch(`https://platform${path}`, init);
  const body = (await response.json().catch(() => ({}))) as T;
  return { status: response.status, body };
}

function readToken(c: { req: { header: (name: string) => string | undefined } }): string {
  const header = c.req.header('authorization') ?? '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
}

async function currentSession(c: { env: Env; req: { header: (name: string) => string | undefined } }): Promise<AdminSession | null> {
  const token = readToken(c);
  if (!token) return null;
  const { status, body } = await platformJson<{ adminId?: string; username?: string; role?: 'owner' | 'operator'; expiresAt?: number; error?: string }>(
    c.env,
    `/session?token=${encodeURIComponent(token)}`,
  );
  if (status !== 200 || !body.adminId) return null;
  return { adminId: body.adminId, username: body.username ?? '', role: body.role ?? 'operator', expiresAt: body.expiresAt ?? 0 };
}

async function requireSession(c: Parameters<typeof currentSession>[0]): Promise<AdminSession | Response> {
  const session = await currentSession(c);
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  return session;
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

async function resolveEvent(env: Env, codeInput: string): Promise<EventMeta | null> {
  const code = normalizeCode(codeInput);
  if (code.length !== 6) return null;
  const { status, body } = await platformJson<{ event?: EventMeta }>(env, `/resolve?code=${encodeURIComponent(code)}`);
  if (status !== 200 || !body.event) return null;
  const meta = body.event;
  // Selalu pastikan DO punya meta (idempoten), termasuk lomba yang dibuat versi lama.
  const stub = env.EVENT.get(env.EVENT.idFromName(meta.id));
  await stub.fetch('https://event/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ meta }),
  });
  return meta;
}

function eventStub(env: Env, eventId: string) {
  return env.EVENT.get(env.EVENT.idFromName(eventId));
}

// ---------- auth ----------

app.post('/api/auth/login', async (c) => {
  // Pembatas percobaan disimpan di PlatformDO supaya berlaku lintas isolate —
  // Map di level modul hilang setiap isolate didaur ulang dan memakan memori.
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  const body = (await c.req.json().catch(() => ({}))) as { username?: string; password?: string };
  const { status, body: result } = await platformJson<Record<string, unknown>>(c.env, '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: body.username, password: body.password, ip }),
  });
  if (status === 429) {
    return c.json({ error: 'too_many_attempts', message: 'Terlalu banyak percobaan. Tunggu 5 menit.' }, 429);
  }
  if (status !== 200) {
    return c.json({ error: 'invalid_credentials', message: 'Nama pengguna atau sandi salah.' }, 401);
  }
  return c.json(result, 200);
});

app.get('/api/auth/me', async (c) => {
  const session = await requireSession(c);
  if (isResponse(session)) return session;
  return c.json({ admin: { id: session.adminId, username: session.username, role: session.role }, expiresAt: session.expiresAt });
});

app.post('/api/auth/logout', async (c) => {
  const token = readToken(c);
  if (token) {
    await platformJson(c.env, '/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  }
  return c.json({ ok: true });
});

// ---------- admins ----------

app.get('/api/admins', async (c) => {
  const session = await requireSession(c);
  if (isResponse(session)) return session;
  const { status, body } = await platformJson<{ admins?: unknown[] }>(c.env, '/admins');
  return c.json(body, status as 200);
});

app.post('/api/admins', async (c) => {
  const session = await requireSession(c);
  if (isResponse(session)) return session;
  if (session.role !== 'owner') return c.json({ error: 'forbidden', message: 'Hanya owner yang bisa menambah admin.' }, 403);
  const payload = (await c.req.json().catch(() => ({}))) as { username?: string; password?: string; role?: string };
  const { status, body } = await platformJson<Record<string, unknown>>(c.env, '/admins', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return c.json(body, status as 200);
});

app.patch('/api/admins', async (c) => {
  const session = await requireSession(c);
  if (isResponse(session)) return session;
  const payload = (await c.req.json().catch(() => ({}))) as { username?: string; password?: string; currentPassword?: string };
  const { status, body } = await platformJson<Record<string, unknown>>(c.env, '/admins', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: session.adminId,
      username: payload.username,
      password: payload.password,
      currentPassword: payload.currentPassword,
      keepSessionId: await sha256Hex(readToken(c)),
    }),
  });
  return c.json(body, status as 200);
});

app.delete('/api/admins/:id', async (c) => {
  const session = await requireSession(c);
  if (isResponse(session)) return session;
  if (session.role !== 'owner') return c.json({ error: 'forbidden' }, 403);
  const { status, body } = await platformJson<Record<string, unknown>>(c.env, `/admins?id=${encodeURIComponent(c.req.param('id'))}`, { method: 'DELETE' });
  return c.json(body, status as 200);
});

// ---------- events ----------

app.get('/api/events', async (c) => {
  const session = await requireSession(c);
  if (isResponse(session)) return session;
  const { status, body } = await platformJson<{ events?: EventMeta[] }>(c.env, '/events');
  return c.json(body, status as 200);
});

app.post('/api/events', async (c) => {
  const session = await requireSession(c);
  if (isResponse(session)) return session;
  const payload = (await c.req.json().catch(() => ({}))) as { name?: string };
  const { status, body } = await platformJson<{ event?: EventMeta }>(c.env, '/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: payload.name, createdBy: session.adminId }),
  });
  if (status === 201 && body.event) {
    const stub = eventStub(c.env, body.event.id);
    await stub.fetch('https://event/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meta: body.event }),
    });
  }
  return c.json(body, status as 200);
});

app.get('/api/events/:id', async (c) => {
  const session = await requireSession(c);
  if (isResponse(session)) return session;
  const { status, body } = await platformJson<Record<string, unknown>>(c.env, `/event?id=${encodeURIComponent(c.req.param('id'))}`);
  return c.json(body, status as 200);
});

app.delete('/api/events/:id', async (c) => {
  const session = await requireSession(c);
  if (isResponse(session)) return session;
  if (session.role !== 'owner') return c.json({ error: 'forbidden', message: 'Hanya owner yang bisa menghapus lomba.' }, 403);
  const eventId = c.req.param('id');
  await eventStub(c.env, eventId).fetch('https://event/delete', { method: 'POST' }).catch(() => undefined);
  const { status, body } = await platformJson<Record<string, unknown>>(c.env, `/events?id=${encodeURIComponent(eventId)}`, { method: 'DELETE' });
  return c.json(body, status as 200);
});

app.post('/api/events/:id/action', async (c) => {
  const session = await requireSession(c);
  if (isResponse(session)) return session;
  const meta = await resolveEvent(c.env, (c.req.param('id') ?? '').toUpperCase());
  const eventId = meta?.id ?? c.req.param('id');
  const payload = (await c.req.json().catch(() => ({}))) as { action?: string; payload?: Record<string, unknown> };
  if (!payload.action) return c.json({ error: 'action_required' }, 400);
  const response = await eventStub(c.env, eventId).fetch('https://event/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: payload.action, payload: payload.payload ?? {}, adminId: session.adminId }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return c.json(body, response.status as 200);
});

app.get('/api/events/:id/state', async (c) => {
  const session = await requireSession(c);
  if (isResponse(session)) return session;
  const eventId = c.req.param('id');
  const response = await eventStub(c.env, eventId).fetch('https://event/snapshot?role=admin');
  const body = (await response.json()) as { snapshot?: Snapshot };
  return c.json(body, response.status as 200);
});

// ---------- publik ----------

app.get('/api/public/events/:code', async (c) => {
  const meta = await resolveEvent(c.env, c.req.param('code'));
  if (!meta) return c.json({ error: 'not_found', message: 'Kode lomba tidak ditemukan.' }, 404);
  const response = await eventStub(c.env, meta.id).fetch('https://event/public');
  return c.json(await response.json(), response.status as 200);
});

app.post('/api/join', async (c) => {
  const payload = (await c.req.json().catch(() => ({}))) as { code?: string; teamName?: string };
  const meta = await resolveEvent(c.env, payload.code ?? '');
  if (!meta) return c.json({ error: 'bad_code', message: 'Kode lomba tidak dikenali. Periksa lagi 6 karakter dari operator.' }, 404);
  const response = await eventStub(c.env, meta.id).fetch('https://event/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ teamName: payload.teamName, code: meta.code }),
  });
  const body = await response.json();
  return c.json(body, response.status as 200);
});

app.get('/api/screen/:code', async (c) => {
  const meta = await resolveEvent(c.env, c.req.param('code'));
  if (!meta) return c.json({ error: 'not_found' }, 404);
  const response = await eventStub(c.env, meta.id).fetch('https://event/snapshot?role=screen');
  return c.json(await response.json(), response.status as 200);
});

// ---------- websocket ----------

app.get('/ws/event/:code', async (c) => {
  if ((c.req.header('upgrade') ?? '').toLowerCase() !== 'websocket') {
    return c.json({ error: 'upgrade_required' }, 426);
  }
  const origin = c.req.header('origin');
  if (!isAllowedOrigin(c.env, origin)) return c.json({ error: 'origin_not_allowed' }, 403);
  const meta = await resolveEvent(c.env, c.req.param('code'));
  if (!meta) return c.json({ error: 'not_found' }, 404);
  const headers = new Headers(c.req.raw.headers);
  return eventStub(c.env, meta.id).fetch('https://event/ws', { method: 'GET', headers });
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
};

export { PlatformDO } from './platform';
export { EventDO } from './event';
