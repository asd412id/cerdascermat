import { DurableObject } from 'cloudflare:workers';
import type { AdminRole, DisplayMode, EventMeta, EventStatus } from '@shared/protocol';
import type { Env } from './env';
import { generateJoinCode, hashPassword, newId, normalizeCode, randomHex, sha256Hex, verifyPassword } from './auth';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS admins (
    id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    salt TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'operator', created_at INTEGER NOT NULL,
    last_login_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, admin_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft', display_mode TEXT NOT NULL DEFAULT 'top1',
    lead_ms INTEGER NOT NULL DEFAULT 900, decision_ms INTEGER NOT NULL DEFAULT 220,
    tie_ms INTEGER NOT NULL DEFAULT 15, ready_max_u_ms INTEGER NOT NULL DEFAULT 150,
    points_per_round INTEGER NOT NULL DEFAULT 100, created_by TEXT, created_at INTEGER NOT NULL)`,
];

interface AdminRow {
  [key: string]: string | number | null;
  id: string;
  username: string;
  password_hash: string;
  salt: string;
  role: AdminRole;
  created_at: number;
  last_login_at: number | null;
}

interface EventRow {
  [key: string]: string | number | null;
  id: string;
  name: string;
  code: string;
  status: EventStatus;
  display_mode: DisplayMode;
  lead_ms: number;
  decision_ms: number;
  tie_ms: number;
  ready_max_u_ms: number;
  points_per_round: number;
  created_by: string | null;
  created_at: number;
}

function envInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export class PlatformDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private seeded = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const statement of SCHEMA) this.sql.exec(statement);
  }

  private json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  private async ensureSeed(): Promise<void> {
    if (this.seeded) return;
    this.seeded = true;
    const row = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM admins').one();
    if (row.n > 0) return;
    const username = (this.env.OWNER_USERNAME ?? '').trim().toLowerCase();
    const password = this.env.OWNER_PASSWORD ?? '';
    if (!username || password.length < 8) return;
    const { hash, salt } = await hashPassword(password);
    this.sql.exec(
      'INSERT INTO admins (id, username, password_hash, salt, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      newId('adm'),
      username,
      hash,
      salt,
      'owner',
      Date.now(),
    );
  }

  private sessionTtlMs(): number {
    return envInt(this.env.SESSION_TTL_HOURS, 12) * 3600_000;
  }

  private async createSession(adminId: string): Promise<{ token: string; expiresAt: number }> {
    const token = randomHex(32);
    const id = await sha256Hex(token);
    const now = Date.now();
    const expiresAt = now + this.sessionTtlMs();
    this.sql.exec('DELETE FROM sessions WHERE expires_at < ?', now);
    this.sql.exec('INSERT INTO sessions (id, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?)', id, adminId, expiresAt, now);
    return { token, expiresAt };
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureSeed();
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/login' && request.method === 'POST') return await this.handleLogin(request);
      if (path === '/session' && request.method === 'GET') return await this.handleSession(url);
      if (path === '/logout' && request.method === 'POST') return await this.handleLogout(request);
      if (path === '/admins' && request.method === 'GET') return this.listAdmins();
      if (path === '/admins' && request.method === 'POST') return await this.createAdmin(request);
      if (path === '/admins' && request.method === 'PATCH') return await this.updateAdmin(request);
      if (path === '/admins' && request.method === 'DELETE') return this.deleteAdmin(url);
      if (path === '/events' && request.method === 'GET') return this.listEvents();
      if (path === '/events' && request.method === 'POST') return await this.createEvent(request);
      if (path === '/events' && request.method === 'PATCH') return await this.updateEvent(request);
      if (path === '/events' && request.method === 'DELETE') return this.deleteEvent(url);
      if (path === '/event' && request.method === 'GET') return this.getEvent(url);
      if (path === '/resolve' && request.method === 'GET') return this.resolveCode(url);
      return this.json({ error: 'not_found' }, 404);
    } catch (error) {
      return this.json({ error: 'internal', message: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  private async handleLogin(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { username?: string; password?: string };
    const username = (body.username ?? '').trim().toLowerCase();
    const password = body.password ?? '';
    if (!username || !password) return this.json({ error: 'invalid_credentials' }, 401);
    const admin = this.sql
      .exec<AdminRow>('SELECT * FROM admins WHERE username = ?', username)
      .toArray()[0];
    if (!admin) return this.json({ error: 'invalid_credentials' }, 401);
    const ok = await verifyPassword(password, admin.password_hash, admin.salt);
    if (!ok) return this.json({ error: 'invalid_credentials' }, 401);
    const { token, expiresAt } = await this.createSession(admin.id);
    this.sql.exec('UPDATE admins SET last_login_at = ? WHERE id = ?', Date.now(), admin.id);
    return this.json({
      token,
      expiresAt,
      admin: { id: admin.id, username: admin.username, role: admin.role },
    });
  }

  private async handleSession(url: URL): Promise<Response> {
    const token = url.searchParams.get('token') ?? '';
    if (!token) return this.json({ error: 'unauthorized' }, 401);
    const id = await sha256Hex(token);
    const row = this.sql
      .exec<{ admin_id: string; expires_at: number; username: string; role: AdminRole }>(
        `SELECT s.admin_id, s.expires_at, a.username, a.role FROM sessions s
         JOIN admins a ON a.id = s.admin_id WHERE s.id = ?`,
        id,
      )
      .toArray()[0];
    if (!row || row.expires_at < Date.now()) return this.json({ error: 'unauthorized' }, 401);
    return this.json({ adminId: row.admin_id, username: row.username, role: row.role, expiresAt: row.expires_at });
  }

  private async handleLogout(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { token?: string };
    if (body.token) this.sql.exec('DELETE FROM sessions WHERE id = ?', await sha256Hex(body.token));
    return this.json({ ok: true });
  }

  private listAdmins(): Response {
    const rows = this.sql
      .exec<{ id: string; username: string; role: AdminRole; created_at: number; last_login_at: number | null }>(
        'SELECT id, username, role, created_at, last_login_at FROM admins ORDER BY created_at',
      )
      .toArray();
    return this.json({ admins: rows });
  }

  private async createAdmin(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { username?: string; password?: string; role?: AdminRole };
    const username = (body.username ?? '').trim().toLowerCase();
    const password = body.password ?? '';
    const role: AdminRole = body.role === 'owner' ? 'owner' : 'operator';
    if (username.length < 3) return this.json({ error: 'username_too_short' }, 400);
    if (password.length < 8) return this.json({ error: 'password_too_short' }, 400);
    const exists = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM admins WHERE username = ?', username).one();
    if (exists.n > 0) return this.json({ error: 'username_taken' }, 409);
    const { hash, salt } = await hashPassword(password);
    const id = newId('adm');
    this.sql.exec(
      'INSERT INTO admins (id, username, password_hash, salt, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      username,
      hash,
      salt,
      role,
      Date.now(),
    );
    return this.json({ admin: { id, username, role } }, 201);
  }

  /** Ganti nama pengguna dan/atau sandi milik satu admin, setelah sandi lamanya diverifikasi. */
  private async updateAdmin(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      id?: string;
      username?: string;
      password?: string;
      currentPassword?: string;
      keepSessionId?: string;
    };
    const row = this.sql.exec<AdminRow>('SELECT * FROM admins WHERE id = ?', body.id ?? '').toArray()[0];
    if (!row) return this.json({ error: 'not_found', message: 'Admin tidak ditemukan.' }, 404);

    const current = body.currentPassword ?? '';
    if (!current) return this.json({ error: 'current_password_required', message: 'Sandi saat ini wajib diisi.' }, 400);
    const ok = await verifyPassword(current, row.password_hash, row.salt);
    if (!ok) return this.json({ error: 'invalid_password', message: 'Sandi saat ini salah.' }, 401);

    const username = body.username === undefined ? row.username : (body.username ?? '').trim().toLowerCase();
    if (username.length < 3) return this.json({ error: 'username_too_short', message: 'Nama pengguna minimal 3 karakter.' }, 400);
    const password = body.password ?? '';
    if (password && password.length < 8) return this.json({ error: 'password_too_short', message: 'Sandi minimal 8 karakter.' }, 400);
    if (username !== row.username) {
      const taken = this.sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM admins WHERE username = ? AND id <> ?', username, row.id)
        .one();
      if (taken.n > 0) return this.json({ error: 'username_taken', message: 'Nama pengguna sudah dipakai.' }, 409);
    }

    if (username !== row.username) this.sql.exec('UPDATE admins SET username = ? WHERE id = ?', username, row.id);
    if (password) {
      const { hash, salt } = await hashPassword(password);
      this.sql.exec('UPDATE admins SET password_hash = ?, salt = ? WHERE id = ?', hash, salt, row.id);
      // Sesi lain dicabut; tab yang dipakai mengganti sandi tetap masuk.
      this.sql.exec('DELETE FROM sessions WHERE admin_id = ? AND id <> ?', row.id, body.keepSessionId ?? '');
    }
    return this.json({ admin: { id: row.id, username, role: row.role }, passwordChanged: Boolean(password) });
  }

  private deleteAdmin(url: URL): Response {
    const id = url.searchParams.get('id') ?? '';
    const target = this.sql.exec<AdminRow>('SELECT * FROM admins WHERE id = ?', id).toArray()[0];
    if (!target) return this.json({ error: 'not_found' }, 404);
    const owners = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM admins WHERE role = 'owner'").one();
    if (target.role === 'owner' && owners.n <= 1) return this.json({ error: 'last_owner' }, 409);
    this.sql.exec('DELETE FROM sessions WHERE admin_id = ?', id);
    this.sql.exec('DELETE FROM admins WHERE id = ?', id);
    return this.json({ ok: true });
  }

  private mapEvent(row: EventRow): EventMeta {
    return {
      id: row.id,
      name: row.name,
      code: row.code,
      status: row.status,
      displayMode: row.display_mode,
      leadMs: row.lead_ms,
      decisionMs: row.decision_ms,
      tieMs: row.tie_ms,
      readyMaxUMs: row.ready_max_u_ms,
      pointsPerRound: row.points_per_round,
    };
  }

  private listEvents(): Response {
    const rows = this.sql.exec<EventRow>('SELECT * FROM events ORDER BY created_at DESC').toArray();
    return this.json({ events: rows.map((r) => this.mapEvent(r)) });
  }

  private getEvent(url: URL): Response {
    const id = url.searchParams.get('id') ?? '';
    const row = this.sql.exec<EventRow>('SELECT * FROM events WHERE id = ?', id).toArray()[0];
    if (!row) return this.json({ error: 'not_found' }, 404);
    return this.json({ event: this.mapEvent(row) });
  }

  private deleteEvent(url: URL): Response {
    const id = url.searchParams.get('id') ?? '';
    const row = this.sql.exec<EventRow>('SELECT * FROM events WHERE id = ?', id).toArray()[0];
    if (!row) return this.json({ error: 'not_found', message: 'Lomba tidak ditemukan.' }, 404);
    this.sql.exec('DELETE FROM events WHERE id = ?', id);
    return this.json({ ok: true });
  }

  private resolveCode(url: URL): Response {
    const code = normalizeCode(url.searchParams.get('code') ?? '');
    const row = this.sql.exec<EventRow>('SELECT * FROM events WHERE code = ?', code).toArray()[0];
    if (!row) return this.json({ error: 'not_found' }, 404);
    return this.json({ event: this.mapEvent(row) });
  }

  private async createEvent(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      name?: string;
      createdBy?: string;
      pointsPerRound?: number;
      leadMs?: number;
      decisionMs?: number;
      tieMs?: number;
      readyMaxUMs?: number;
    };
    const name = (body.name ?? '').trim();
    if (name.length < 3) return this.json({ error: 'name_too_short' }, 400);

    let code = generateJoinCode();
    for (let i = 0; i < 8; i += 1) {
      const clash = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE code = ?', code).one();
      if (clash.n === 0) break;
      code = generateJoinCode();
    }

    const now = Date.now();
    const id = newId('evt');
    this.sql.exec(
      `INSERT INTO events (id, name, code, status, display_mode, lead_ms, decision_ms, tie_ms, ready_max_u_ms, points_per_round, created_by, created_at)
       VALUES (?, ?, ?, 'open', 'top1', ?, ?, ?, ?, ?, ?, ?)`,
      id,
      name,
      code,
      Math.min(5000, Math.max(100, body.leadMs ?? envInt(this.env.LEAD_MS, 900))),
      Math.min(2000, Math.max(60, body.decisionMs ?? envInt(this.env.DECISION_MS, 220))),
      Math.min(500, Math.max(0, body.tieMs ?? envInt(this.env.TIE_MS, 15))),
      Math.min(2000, Math.max(40, body.readyMaxUMs ?? envInt(this.env.READY_MAX_U_MS, 150))),
      Math.min(10_000, Math.max(1, body.pointsPerRound ?? 100)),
      body.createdBy ?? null,
      now,
    );
    const row = this.sql.exec<EventRow>('SELECT * FROM events WHERE id = ?', id).one();
    return this.json({ event: this.mapEvent(row) }, 201);
  }

  private async updateEvent(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      id?: string;
      status?: EventStatus;
      displayMode?: DisplayMode;
      name?: string;
      pointsPerRound?: number;
    };
    const id = body.id ?? '';
    const existing = this.sql.exec<EventRow>('SELECT * FROM events WHERE id = ?', id).toArray()[0];
    if (!existing) return this.json({ error: 'not_found' }, 404);

    if (body.status) {
      if (!['draft', 'open', 'live', 'closed'].includes(body.status)) return this.json({ error: 'bad_status' }, 400);
      this.sql.exec('UPDATE events SET status = ? WHERE id = ?', body.status, id);
    }
    if (body.displayMode) {
      if (!['top1', 'all'].includes(body.displayMode)) return this.json({ error: 'bad_mode' }, 400);
      this.sql.exec('UPDATE events SET display_mode = ? WHERE id = ?', body.displayMode, id);
    }
    if (typeof body.name === 'string' && body.name.trim().length >= 3) {
      this.sql.exec('UPDATE events SET name = ? WHERE id = ?', body.name.trim(), id);
    }
    if (typeof body.pointsPerRound === 'number' && body.pointsPerRound > 0) {
      this.sql.exec('UPDATE events SET points_per_round = ? WHERE id = ?', Math.floor(body.pointsPerRound), id);
    }
    const row = this.sql.exec<EventRow>('SELECT * FROM events WHERE id = ?', id).one();
    return this.json({ event: this.mapEvent(row) });
  }
}
