import { DurableObject } from 'cloudflare:workers';
import { rankPresses, type PressInput } from '@shared/rank';
import {
  APP_VERSION,
  PRESENCE_TIMEOUT_MS,
  READY_SYNC_MAX_AGE_MS,
  type AttemptInfo,
  type AuditEntry,
  type DisplayMode,
  type EventMeta,
  type EventStatus,
  type RankingEntry,
  type Role,
  type RoundInfo,
  type ServerMessage,
  type Snapshot,
  type TeamPublic,
} from '@shared/protocol';
import { normalizePress, pressNeedsReview, pressWindow, requiresExplicitChoice, tieRequiresChoice } from '@shared/rank';
import type { Env } from './env';
import { newId, normalizeCode, randomHex, sha256Hex, timingSafeEqual } from './auth';

/** Batas atas RTT yang masuk akal; klien melaporkan `u` = RTT/2, jadi RTT = 2u. */
const MAX_RTT_MS = 4000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, token_hash TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL, last_seen_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active', rtt_min_ms REAL)`,
  `CREATE TABLE IF NOT EXISTS rounds (
    id TEXT PRIMARY KEY, seq INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'idle',
    awarded_team_id TEXT, result TEXT, points INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS round_attempts (
    id TEXT PRIMARY KEY, round_id TEXT NOT NULL, idx INTEGER NOT NULL, open_at INTEGER NOT NULL,
    close_at INTEGER, nonce TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
    candidate_idx INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS presses (
    id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, team_id TEXT NOT NULL, d_ms REAL NOT NULL,
    d_norm_ms REAL NOT NULL, u_ms REAL NOT NULL, recv_ms INTEGER NOT NULL,
    flags TEXT NOT NULL DEFAULT '[]', ordinal INTEGER NOT NULL, UNIQUE (attempt_id, team_id))`,
  `CREATE TABLE IF NOT EXISTS score_edits (
    id TEXT PRIMARY KEY, team_id TEXT NOT NULL, delta INTEGER NOT NULL, reason TEXT NOT NULL,
    admin_id TEXT, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit (
    id TEXT PRIMARY KEY, admin_id TEXT, action TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL)`,
];

interface TeamRow {
  [key: string]: string | number | null;
  id: string;
  name: string;
  token_hash: string;
  score: number;
  joined_at: number;
  last_seen_at: number | null;
  status: string;
  rtt_min_ms: number | null;
}

interface RoundRow {
  [key: string]: string | number | null;
  id: string;
  seq: number;
  status: RoundInfo['status'];
  awarded_team_id: string | null;
  result: 'correct' | 'void' | null;
  points: number;
  created_at: number;
}

interface AttemptRow {
  [key: string]: string | number | null;
  id: string;
  round_id: string;
  idx: number;
  open_at: number;
  close_at: number | null;
  nonce: string;
  status: AttemptInfo['status'];
  candidate_idx: number;
  created_at: number;
}

interface PressRow {
  [key: string]: string | number | null;
  id: string;
  attempt_id: string;
  team_id: string;
  d_ms: number;
  d_norm_ms: number;
  u_ms: number;
  recv_ms: number;
  flags: string;
  ordinal: number;
}

interface Attachment {
  role: Role | null;
  teamId?: string;
  adminId?: string;
}

const MAX_TEAM_NAME = 32;
const MAX_TEAMS = 400;

function cleanTeamName(input: string): string {
  return input.replace(/\s+/g, ' ').trim().slice(0, MAX_TEAM_NAME);
}

export class EventDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private meta: EventMeta | null = null;
  private readonly presence = new Map<string, number>();
  private readonly syncState = new Map<string, { at: number; u: number }>();
  private readonly lastPersist = new Map<string, number>();
  private teamsDirty = false;
  private teamsTimer: ReturnType<typeof setTimeout> | null = null;
  private readyKey = '';
  private readyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const statement of SCHEMA) this.sql.exec(statement);
  }

  private json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }

  // ---------- meta ----------

  /** Meta lomba yang tersimpan, atau null bila lomba sudah dihapus. */
  private readMeta(): EventMeta | null {
    if (this.meta) return this.meta;
    const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'event'").toArray()[0];
    if (!row) return null;
    this.meta = JSON.parse(row.value) as EventMeta;
    return this.meta;
  }

  /** Dipakai timer & socket agar tidak meledak setelah /delete mengosongkan meta. */
  private hasEvent(): boolean {
    return this.readMeta() !== null;
  }

  private loadMeta(): EventMeta {
    const meta = this.readMeta();
    if (!meta) throw new Error('event_not_initialized');
    return meta;
  }

  private saveMeta(patch: Partial<EventMeta>): EventMeta {
    const next = { ...this.loadMeta(), ...patch };
    this.meta = next;
    this.sql.exec("INSERT INTO meta (key, value) VALUES ('event', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(next));
    return next;
  }

  // ---------- queries ----------

  private teams(): TeamRow[] {
    return this.sql.exec<TeamRow>('SELECT * FROM teams ORDER BY joined_at').toArray();
  }

  private isOnline(teamId: string, now = Date.now()): boolean {
    const seen = this.presence.get(teamId);
    return seen !== undefined && now - seen < PRESENCE_TIMEOUT_MS;
  }

  private teamsPublic(): TeamPublic[] {
    const now = Date.now();
    return this.teams().map((t) => ({
      id: t.id,
      name: t.name,
      score: t.score,
      online: this.isOnline(t.id, now),
      lastSeenAt: t.last_seen_at ?? 0,
      rttMinMs: t.rtt_min_ms,
    }));
  }

  private latestRound(): RoundRow | null {
    return this.sql.exec<RoundRow>('SELECT * FROM rounds ORDER BY seq DESC LIMIT 1').toArray()[0] ?? null;
  }

  private latestAttempt(roundId?: string): AttemptRow | null {
    if (roundId) {
      return this.sql
        .exec<AttemptRow>('SELECT * FROM round_attempts WHERE round_id = ? ORDER BY idx DESC LIMIT 1', roundId)
        .toArray()[0] ?? null;
    }
    return this.sql.exec<AttemptRow>('SELECT * FROM round_attempts ORDER BY created_at DESC LIMIT 1').toArray()[0] ?? null;
  }

  private attemptRanking(attempt: AttemptRow): { ranking: RankingEntry[]; tie: boolean; tiedTeamIds: string[] } {
    const meta = this.loadMeta();
    const presses = this.sql
      .exec<PressRow>('SELECT * FROM presses WHERE attempt_id = ? ORDER BY ordinal', attempt.id)
      .toArray();
    if (presses.length === 0) return { ranking: [], tie: false, tiedTeamIds: [] };
    const teams = new Map(this.teams().map((t) => [t.id, t]));
    const inputs: PressInput[] = presses.map((p) => ({
      teamId: p.team_id,
      d: p.d_ms,
      u: p.u_ms,
      recvDelta: p.recv_ms - attempt.open_at,
    }));
    const result = rankPresses(inputs, meta.tieMs);
    // dNorm dihitung ulang dari klaim tersimpan agar konsisten setelah tieMs berubah.
    const byTeam = new Map(presses.map((p) => [p.team_id, p]));
    const ranking: RankingEntry[] = result.ranking.map((r) => {
      const stored = byTeam.get(r.teamId);
      const flags = stored?.flags ? (JSON.parse(stored.flags) as string[]) : r.flags;
      return {
        teamId: r.teamId,
        name: teams.get(r.teamId)?.name ?? 'Tim',
        rank: r.rank,
        dNorm: Math.round(r.dNorm * 10) / 10,
        dRaw: Math.round(r.dRaw * 10) / 10,
        u: Math.round(r.u * 10) / 10,
        flags,
        gapMs: Math.round(r.gapMs * 10) / 10,
        // Selisih waktu tiba dengan klaim = ongkos jaringan (plus galat offset).
        deliveryMs: Math.round(((stored?.recv_ms ?? attempt.open_at) - attempt.open_at - (stored?.d_ms ?? r.dRaw)) * 10) / 10,
        needsReview: r.needsReview || pressNeedsReview(flags),
      };
    });
    return { ranking, tie: result.tie, tiedTeamIds: result.tiedTeamIds };
  }

  private candidateTeamId(attempt: AttemptRow | null, ranking: RankingEntry[]): string | null {
    if (!attempt || ranking.length === 0) return null;
    return ranking[Math.min(attempt.candidate_idx, ranking.length - 1)]?.teamId ?? null;
  }

  private readyTeamIds(): string[] {
    const meta = this.loadMeta();
    const now = Date.now();
    return this.teams()
      .filter((t) => {
        if (!this.isOnline(t.id, now)) return false;
        const sync = this.syncState.get(t.id);
        if (!sync) return false;
        return now - sync.at < READY_SYNC_MAX_AGE_MS && sync.u <= meta.readyMaxUMs;
      })
      .map((t) => t.id);
  }

  private snapshot(role: Role): Snapshot {
    const meta = this.loadMeta();
    const round = this.latestRound();
    const attempt = round ? this.latestAttempt(round.id) : null;
    const { ranking, tie, tiedTeamIds } = attempt ? this.attemptRanking(attempt) : { ranking: [], tie: false, tiedTeamIds: [] };
    const audit: AuditEntry[] =
      role === 'admin'
        ? this.sql.exec<{ id: string; admin_id: string | null; action: string; payload: string; created_at: number }>(
            'SELECT * FROM audit ORDER BY created_at DESC LIMIT 40',
          ).toArray().map((a) => ({ id: a.id, adminId: a.admin_id, action: a.action, payload: JSON.parse(a.payload), createdAt: a.created_at }))
        : [];
    return {
      appVersion: APP_VERSION,
      serverTime: Date.now(),
      event: meta,
      teams: this.teamsPublic(),
      round: round
        ? { id: round.id, seq: round.seq, status: round.status, awardedTeamId: round.awarded_team_id, result: round.result, points: round.points }
        : null,
      attempt: attempt
        ? {
            id: attempt.id,
            roundId: attempt.round_id,
            idx: attempt.idx,
            openAt: attempt.open_at,
            closeAt: attempt.close_at,
            nonce: attempt.nonce,
            status: attempt.status,
            candidateIdx: attempt.candidate_idx,
          }
        : null,
      ranking,
      tie,
      tiedTeamIds,
      candidateTeamId: this.candidateTeamId(attempt, ranking),
      audit,
      readyTeamIds: this.readyTeamIds(),
    };
  }

  // ---------- transport ----------

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // socket sudah tertutup; biarkan handler close yang membersihkan
    }
  }

  private broadcast(message: ServerMessage, options: { roles?: Role[]; except?: WebSocket } = {}): void {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === options.except) continue;
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att?.role) continue;
      if (options.roles && !options.roles.includes(att.role)) continue;
      try {
        ws.send(payload);
      } catch {
        // abaikan socket mati
      }
    }
  }

  /**
   * Kesiapan tim menentukan tombol "buka rebutan", jadi admin harus tahu
   * tanpa menunggu aksi lain. Siarkan snapshot hanya saat daftar siap berubah.
   */
  private markReadyChanged(): void {
    if (this.readyTimer) return;
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (!this.hasEvent()) return;
      const key = this.readyTeamIds().join(',');
      if (key === this.readyKey) return;
      this.readyKey = key;
      this.broadcast({ type: 'state', snapshot: this.snapshot('admin') }, { roles: ['admin'] });
    }, 120);
  }

  private markTeamsChanged(): void {
    this.teamsDirty = true;
    if (this.teamsTimer) return;
    this.teamsTimer = setTimeout(() => {
      this.teamsTimer = null;
      if (!this.teamsDirty || !this.hasEvent()) return;
      this.teamsDirty = false;
      this.broadcast({ type: 'teams.updated', teams: this.teamsPublic() }, { roles: ['admin', 'screen', 'team'] });
    }, 100);
  }

  private audit(adminId: string | null, action: string, payload: unknown): void {
    this.sql.exec(
      'INSERT INTO audit (id, admin_id, action, payload, created_at) VALUES (?, ?, ?, ?, ?)',
      newId('aud'),
      adminId,
      action,
      JSON.stringify(payload ?? {}),
      Date.now(),
    );
  }

  // ---------- HTTP ----------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/init' && request.method === 'POST') return await this.handleInit(request);
      if (path === '/join' && request.method === 'POST') return await this.handleJoin(request);
      if (path === '/public' && request.method === 'GET') {
        const meta = this.loadMeta();
        return this.json({ event: { code: meta.code, name: meta.name, status: meta.status }, teamCount: this.teams().length });
      }
      if (path === '/snapshot' && request.method === 'GET') {
        const role = (url.searchParams.get('role') ?? 'screen') as Role;
        return this.json({ snapshot: this.snapshot(role === 'admin' ? 'admin' : 'screen') });
      }
      if (path === '/action' && request.method === 'POST') return await this.handleAction(request);
      if (path === '/delete' && request.method === 'POST') return await this.handleDelete();
      if (path === '/stats' && request.method === 'GET') {
        const attempt = this.latestAttempt();
        return this.json({
          teams: this.teams().length,
          sockets: this.ctx.getWebSockets().length,
          attempt: attempt?.id ?? null,
          presses: attempt ? this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM presses WHERE attempt_id = ?', attempt.id).one().n : 0,
        });
      }
      if (path === '/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        return this.handleWebSocket(request);
      }
      return this.json({ error: 'not_found' }, 404);
    } catch (error) {
      return this.json({ error: 'internal', message: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  /** Hapus seluruh data lomba: tabel dikosongkan dan socket ditutup. */
  private async handleDelete(): Promise<Response> {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    if (this.teamsTimer) {
      clearTimeout(this.teamsTimer);
      this.teamsTimer = null;
    }
    this.teamsDirty = false;
    // Beri tahu lebih dulu: peserta, layar, dan admin lain harus tahu lombanya
    // dihapus tanpa menunggu percobaan sambung ulang yang pasti gagal (kode
    // sudah tidak dikenal), lalu keluar ke halaman daftar.
    const deleted: ServerMessage = { type: 'hello.err', code: 'deleted', message: 'Lomba dihapus operator.' };
    for (const ws of this.ctx.getWebSockets()) {
      this.send(ws, deleted);
      try {
        ws.close(1001, 'event_deleted');
      } catch {
        // socket sudah tertutup
      }
    }
    // Tabel dikosongkan, bukan dihapus: DO yang masih hidup harus tetap bisa
    // melayani /init bila lomba dibuat lagi.
    for (const table of ['presses', 'round_attempts', 'rounds', 'score_edits', 'audit', 'teams', 'meta']) {
      this.sql.exec(`DELETE FROM ${table}`);
    }
    this.meta = null;
    this.presence.clear();
    this.syncState.clear();
    this.lastPersist.clear();
    this.readyKey = '';
    return this.json({ ok: true });
  }

  private async handleInit(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { meta?: EventMeta; force?: boolean };
    if (!body.meta) return this.json({ error: 'bad_request' }, 400);
    const existing = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'event'").toArray()[0];
    if (!existing || body.force) {
      this.meta = body.meta;
      this.sql.exec(
        "INSERT INTO meta (key, value) VALUES ('event', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        JSON.stringify(body.meta),
      );
    } else {
      this.meta = JSON.parse(existing.value) as EventMeta;
    }
    return this.json({ ok: true, meta: this.loadMeta() });
  }

  private async handleJoin(request: Request): Promise<Response> {
    const meta = this.loadMeta();
    if (meta.status !== 'open') return this.json({ error: 'event_closed', message: 'Pendaftaran sudah ditutup operator.' }, 409);
    const body = (await request.json().catch(() => ({}))) as { teamName?: string; code?: string };
    if (normalizeCode(body.code ?? '') !== meta.code)
      return this.json(
        { error: 'bad_code', message: 'Kode lomba tidak dikenali. Periksa lagi 6 karakter dari operator.' },
        404,
      );
    const name = cleanTeamName(body.teamName ?? '');
    if (name.length < 2) return this.json({ error: 'name_too_short', message: 'Nama tim minimal 2 karakter.' }, 400);

    // Hash token (async) diselesaikan lebih dulu supaya cek kuota/nama dan INSERT
    // di bawah berjalan dalam satu blok sinkron: Durable Object memproses satu event
    // sekaligus, jadi dua join bersamaan tidak bisa sama-sama lolos.
    const token = randomHex(24);
    const tokenHash = await sha256Hex(token);
    const id = newId('team');
    const now = Date.now();
    const inserted = this.sql.exec(
      `INSERT INTO teams (id, name, token_hash, score, joined_at, last_seen_at, status)
       SELECT ?, ?, ?, 0, ?, ?, 'active'
       WHERE (SELECT COUNT(*) FROM teams) < ?
         AND NOT EXISTS (SELECT 1 FROM teams WHERE lower(name) = lower(?))`,
      id,
      name,
      tokenHash,
      now,
      now,
      MAX_TEAMS,
      name,
    );

    if (inserted.rowsWritten === 0) {
      const full = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM teams').one().n >= MAX_TEAMS;
      if (full)
        return this.json(
          { error: 'event_full', message: 'Peserta lomba ini sudah penuh. Hubungi operator.' },
          409,
        );
      return this.json(
        { error: 'name_taken', message: `Nama "${name}" sudah dipakai tim lain. Pilih nama yang berbeda.` },
        409,
      );
    }

    this.markTeamsChanged();
    return this.json({ teamId: id, token, teamName: name, eventCode: meta.code, eventId: meta.id, eventName: meta.name }, 201);
  }

  // ---------- websocket ----------

  private handleWebSocket(request: Request): Response {
    const origin = request.headers.get('Origin');
    if (origin && !this.originAllowed(origin)) return this.json({ error: 'origin_not_allowed' }, 403);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role: null } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
  }

  private originAllowed(origin: string): boolean {
    const list = (this.env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean);
    if (list.length === 0) return true;
    return list.includes(origin.replace(/\/$/, ''));
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string') return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const attachment = (ws.deserializeAttachment() as Attachment | null) ?? { role: null };
    const type = message.type;

    // Lomba sudah dihapus: socket lama tidak boleh menyentuh data yang kosong.
    if (!this.hasEvent()) {
      this.send(ws, { type: 'hello.err', code: 'no_team', message: 'Lomba sudah dihapus.' });
      try {
        ws.close(1001, 'event_deleted');
      } catch {
        // socket sudah tertutup
      }
      return;
    }

    if (type === 'hello') return this.handleHello(ws, message);
    if (type === 'sync') {
      await this.handleSync(ws, attachment, message);
      return;
    }
    if (type === 'ping') {
      if (attachment.teamId) this.touchTeam(attachment.teamId);
      this.send(ws, { type: 'pong', t0: Number(message.t0) || 0, t1: Date.now() });
      return;
    }
    if (type === 'press') {
      await this.handlePress(ws, attachment, message);
      return;
    }
    this.send(ws, { type: 'error', message: 'unknown_type' });
  }

  private async handleHello(ws: WebSocket, message: Record<string, unknown>): Promise<void> {
    const role = message.role as Role;
    const appVersion = String(message.appVersion ?? '');
    if (!['team', 'admin', 'screen'].includes(role)) {
      this.send(ws, { type: 'hello.err', code: 'bad_role', message: 'Peran tidak dikenal.' });
      ws.close(1008, 'bad_role');
      return;
    }
    if (appVersion && appVersion !== APP_VERSION) {
      this.send(ws, { type: 'hello.err', code: 'version', message: 'Server diperbarui. Muat ulang halaman.' });
      ws.close(1008, 'version');
      return;
    }

    if (role === 'admin') {
      const token = String(message.token ?? '');
      const session = await this.verifyAdmin(token);
      if (!session) {
        this.send(ws, { type: 'hello.err', code: 'bad_token', message: 'Sesi admin tidak berlaku. Masuk ulang.' });
        ws.close(1008, 'bad_token');
        return;
      }
      ws.serializeAttachment({ role, adminId: session.adminId } satisfies Attachment);
    } else if (role === 'team') {
      const teamId = String(message.teamId ?? '');
      const token = String(message.token ?? '');
      const team = this.sql.exec<TeamRow>('SELECT * FROM teams WHERE id = ?', teamId).toArray()[0];
      if (!team) {
        this.send(ws, { type: 'hello.err', code: 'no_team', message: 'Tim tidak ditemukan. Daftar ulang.' });
        ws.close(1008, 'no_team');
        return;
      }
      const hash = await sha256Hex(token);
      if (!timingSafeEqual(hash, team.token_hash)) {
        this.send(ws, { type: 'hello.err', code: 'bad_token', message: 'Token tim tidak sah. Daftar ulang.' });
        ws.close(1008, 'bad_token');
        return;
      }
      ws.serializeAttachment({ role, teamId } satisfies Attachment);
      this.touchTeam(teamId);
    } else {
      ws.serializeAttachment({ role } satisfies Attachment);
    }

    this.send(ws, { type: 'hello.ok', role, teamId: (ws.deserializeAttachment() as Attachment).teamId, appVersion: APP_VERSION, serverTime: Date.now() });
    this.send(ws, { type: 'state', snapshot: this.snapshot(role) });
    this.markTeamsChanged();
  }

  private async verifyAdmin(token: string): Promise<{ adminId: string } | null> {
    if (!token) return null;
    const stub = this.env.PLATFORM.get(this.env.PLATFORM.idFromName('platform'));
    const response = await stub.fetch(`https://platform/session?token=${encodeURIComponent(token)}`);
    if (!response.ok) return null;
    const body = (await response.json()) as { adminId?: string };
    return body.adminId ? { adminId: body.adminId } : null;
  }

  private touchTeam(teamId: string): void {
    const now = Date.now();
    const wasOnline = this.isOnline(teamId, now);
    this.presence.set(teamId, now);
    const last = this.lastPersist.get(teamId) ?? 0;
    if (now - last > 5000) {
      this.lastPersist.set(teamId, now);
      this.sql.exec('UPDATE teams SET last_seen_at = ? WHERE id = ?', now, teamId);
    }
    if (!wasOnline) this.markTeamsChanged();
  }

  /** Simpan RTT terkecil yang dilaporkan klien (2×u). Hanya untuk tampilan laporan. */
  private recordRtt(teamId: string, rttMs: number): void {
    if (!(rttMs > 0) || rttMs > MAX_RTT_MS) return;
    const current = this.sql.exec<{ rtt_min_ms: number | null }>('SELECT rtt_min_ms FROM teams WHERE id = ?', teamId).toArray()[0];
    if (current?.rtt_min_ms !== null && current?.rtt_min_ms !== undefined && current.rtt_min_ms <= rttMs) return;
    this.sql.exec('UPDATE teams SET rtt_min_ms = ? WHERE id = ?', Math.round(rttMs * 10) / 10, teamId);
  }

  private async handleSync(ws: WebSocket, attachment: Attachment, message: Record<string, unknown>): Promise<void> {
    const t1 = Date.now();
    const seq = Number(message.seq) || 0;
    const t0 = Number(message.t0) || 0;
    const t2 = Date.now();
    if (attachment.teamId) {
      this.touchTeam(attachment.teamId);
      const u = Number(message.u);
      if (Number.isFinite(u) && u >= 0) {
        const clampedU = Math.min(u, 2000);
        this.syncState.set(attachment.teamId, { at: Date.now(), u: clampedU });
        // `u` adalah galat offset jam klien hasil sinkronisasi NTP di perangkat
        // (src/lib/clock.ts: u = rtt/2), jadi RTT ≈ 2u. Nilai ini hanya untuk
        // laporan operator; pemeringkatan memakai `u` yang dijepit server.
        this.recordRtt(attachment.teamId, clampedU * 2);
      }
      this.markReadyChanged();
    }
    this.send(ws, { type: 'sync-ack', seq, t0, t1, t2 });
  }

  private async handlePress(ws: WebSocket, attachment: Attachment, message: Record<string, unknown>): Promise<void> {
    const meta = this.loadMeta();
    const teamId = attachment.teamId;
    if (!teamId) {
      this.send(ws, { type: 'press.rejected', attemptId: String(message.attemptId ?? ''), status: 'invalid', message: 'Hanya tim terautentikasi yang boleh menekan.' });
      return;
    }
    this.touchTeam(teamId);
    const attempt = this.latestAttempt();
    const attemptId = String(message.attemptId ?? '');
    if (!attempt || attempt.id !== attemptId || attempt.nonce !== String(message.nonce ?? '')) {
      this.send(ws, { type: 'press.rejected', attemptId, status: 'closed', message: 'Ronde ini sudah berpindah. Tunggu tombol berikutnya.' });
      return;
    }

    // Duplikat diperiksa lebih dulu: kiriman ulang setelah jaringan putus harus
    // dijawab `dup` (idempoten), bukan ditolak karena jendelanya sudah lewat.
    const duplicate = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM presses WHERE attempt_id = ? AND team_id = ?', attempt.id, teamId).one();
    if (duplicate.n > 0) {
      this.send(ws, { type: 'press.ack', attemptId, status: 'dup' });
      return;
    }

    const now = Date.now();
    const round = this.latestRound();
    const awarded =
      !round || round.id !== attempt.round_id || round.status !== 'open' || attempt.status === 'settled' || attempt.status === 'void';
    const gate = pressWindow({ now, openAt: attempt.open_at, closeAt: attempt.close_at, awarded });
    if (!gate.accept) {
      if (gate.reason === 'early') {
        this.send(ws, { type: 'press.rejected', attemptId, status: 'early', message: 'Tombol belum terbuka. Tunggu warna hijau.' });
        return;
      }
      // Alarm penutup bisa tertunda; tutup attempt yang telanjur lewat jendela.
      if (gate.reason === 'closed' && attempt.status === 'open') this.closeAttempt(attempt.id);
      this.send(ws, {
        type: 'press.rejected',
        attemptId,
        status: 'closed',
        message: gate.reason === 'awarded' ? 'Ronde sudah dinilai.' : 'Tombol sudah ditutup.',
      });
      return;
    }

    const team = this.sql.exec<TeamRow>('SELECT * FROM teams WHERE id = ?', teamId).toArray()[0];
    if (!team) {
      this.send(ws, { type: 'press.rejected', attemptId, status: 'invalid', message: 'Tim tidak dikenal.' });
      return;
    }

    // `u` hanya masuk ke batas atas jendela dan margin seri. Jepit ke ambang yang
    // diakui operator supaya klien tidak bisa menggelembungkannya.
    const u = Math.min(meta.readyMaxUMs, Math.max(0, Number(message.u) || 0));
    const recvDelta = now - attempt.open_at;
    const claim = Number(message.d);
    const normalized = normalizePress({ teamId, d: claim, u, recvDelta });
    // Klaim tidak pernah dinaikkan; kiriman yang tiba setelah tombol ditutup
    // hanya ditandai supaya operator memeriksanya.
    const flags = gate.late ? [...normalized.flags, 'late' as const] : normalized.flags;
    const ordinal = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM presses WHERE attempt_id = ?', attempt.id).one().n + 1;
    this.sql.exec(
      `INSERT INTO presses (id, attempt_id, team_id, d_ms, d_norm_ms, u_ms, recv_ms, flags, ordinal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('prs'),
      attempt.id,
      teamId,
      Number.isFinite(claim) ? claim : recvDelta,
      normalized.dNorm,
      u,
      now,
      JSON.stringify(flags),
      ordinal,
    );

    this.send(ws, { type: 'press.ack', attemptId, status: 'received' });

    if (attempt.status === 'open') {
      if (ordinal === 1) {
        const closeAt = now + meta.decisionMs;
        this.sql.exec('UPDATE round_attempts SET close_at = ? WHERE id = ?', closeAt, attempt.id);
        await this.ctx.storage.setAlarm(closeAt);
      }
      const onlineTeams = this.teams().filter((t) => this.isOnline(t.id)).length;
      if (ordinal >= onlineTeams && onlineTeams > 0) {
        this.closeAttempt(attempt.id);
      }
      return;
    }

    // Attempt sudah ditutup: tekan yang baru tiba mengubah urutan, jadi hasil
    // yang sudah tampil di layar operator harus disiarkan ulang.
    const fresh = this.sql.exec<AttemptRow>('SELECT * FROM round_attempts WHERE id = ?', attempt.id).toArray()[0];
    if (fresh) this.broadcastRanked(fresh);
  }

  private broadcastRanked(attempt: AttemptRow): void {
    const { ranking, tie, tiedTeamIds } = this.attemptRanking(attempt);
    const candidateIdx = ranking.length === 0 ? 0 : Math.min(attempt.candidate_idx, ranking.length - 1);
    this.broadcast({
      type: 'attempt.ranked',
      attemptId: attempt.id,
      ranking,
      tie,
      tiedTeamIds,
      candidateIdx,
      candidateTeamId: ranking[candidateIdx]?.teamId ?? null,
    });
  }

  private closeAttempt(attemptId: string): void {
    const attempt = this.sql.exec<AttemptRow>('SELECT * FROM round_attempts WHERE id = ?', attemptId).toArray()[0];
    if (!attempt || attempt.status !== 'open') return;
    const now = Date.now();
    this.sql.exec("UPDATE round_attempts SET status = 'closed', close_at = COALESCE(close_at, ?) WHERE id = ?", now, attemptId);
    this.broadcastRanked({ ...attempt, status: 'closed' as const, close_at: attempt.close_at ?? now });
  }

  async alarm(): Promise<void> {
    const attempt = this.latestAttempt();
    if (!attempt || attempt.status !== 'open' || !attempt.close_at) return;
    if (Date.now() + 5 < attempt.close_at) {
      await this.ctx.storage.setAlarm(attempt.close_at);
      return;
    }
    this.closeAttempt(attempt.id);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const attachment = (ws.deserializeAttachment() as Attachment | null) ?? { role: null };
    if (attachment.teamId) {
      this.presence.delete(attachment.teamId);
      this.syncState.delete(attachment.teamId);
      this.sql.exec('UPDATE teams SET last_seen_at = ? WHERE id = ?', Date.now(), attachment.teamId);
      this.markTeamsChanged();
      this.markReadyChanged();
    }
    try {
      ws.close(code, reason);
    } catch {
      // sudah tertutup
    }
    void wasClean;
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const attachment = (ws.deserializeAttachment() as Attachment | null) ?? { role: null };
    if (attachment.teamId) {
      this.presence.delete(attachment.teamId);
      this.markTeamsChanged();
      this.markReadyChanged();
    }
    void ws;
    void error;
  }

  // ---------- admin actions ----------

  private async handleAction(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
      payload?: Record<string, unknown>;
      adminId?: string;
    };
    const adminId = body.adminId ?? null;
    const payload = body.payload ?? {};
    const meta = this.loadMeta();

    switch (body.action) {
      case 'open_round': {
        if (meta.status === 'finished') return this.json({ error: 'event_finished', message: 'Lomba sudah selesai.' }, 409);
        const current = this.latestRound();
        const openAttempt = current && current.status === 'open' ? this.latestAttempt(current.id) : null;
        if (current && current.status === 'open' && openAttempt?.status === 'open') {
          return this.json({ ok: true, attempt: this.resetBuzzer(adminId, 'buka ulang') });
        }
        const seq = (this.sql.exec<{ n: number }>('SELECT COALESCE(MAX(seq), 0) AS n FROM rounds').one().n ?? 0) + 1;
        const roundId = newId('rnd');
        const now = Date.now();
        this.sql.exec(
          "INSERT INTO rounds (id, seq, status, points, created_at) VALUES (?, ?, 'open', ?, ?)",
          roundId,
          seq,
          meta.pointsPerRound,
          now,
        );
        const attempt = this.createAttempt(roundId, 0, now + meta.leadMs);
        this.audit(adminId, 'open_round', { roundSeq: seq, attemptId: attempt.id, force: Boolean(payload.force) });
        this.broadcast({ type: 'round.opened', round: this.roundInfo(roundId) });
        this.broadcast({
          type: 'attempt.opened',
          attemptId: attempt.id,
          openAt: attempt.open_at,
          nonce: attempt.nonce,
          leadMs: meta.leadMs,
          roundSeq: seq,
        });
        return this.json({ ok: true, attempt: this.mapAttempt(attempt), round: this.roundInfo(roundId) });
      }

      case 'reset_buzzer': {
        return this.json({ ok: true, attempt: this.resetBuzzer(adminId, 'reset tombol') });
      }

      case 'settle': {
        const round = this.latestRound();
        if (!round || round.status !== 'open') return this.json({ error: 'no_open_round' }, 409);
        const attempt = this.latestAttempt(round.id);
        const { ranking, tie } = attempt ? this.attemptRanking(attempt) : { ranking: [], tie: false };
        // Seri teknis tidak boleh diputuskan diam-diam oleh server: operator harus
        // memilih tim pemenang secara eksplisit (`explicit: true` dari UI setelah
        // menekan tombol kandidat). Klien yang hanya meneruskan kandidat default
        // ditolak, karena kandidat default = urutan abjad, bukan pilihan operator.
        if (tieRequiresChoice(tie, payload))
          return this.json(
            { error: 'tie_requires_choice', message: 'Hasil seri teknis — pilih tim pemenang lebih dulu.' },
            409,
          );
        const teamId = String(payload.teamId ?? (attempt ? this.candidateTeamId(attempt, ranking) : '') ?? '');
        // Tekan yang tiba lewat jaringan lambat (atau klaimnya mustahil) juga
        // wajib dipilih eksplisit: server tidak boleh memberi poin diam-diam
        // berdasarkan urutan abjad.
        const chosen = ranking.find((row) => row.teamId === teamId);
        if (chosen?.needsReview && requiresExplicitChoice(payload))
          return this.json(
            { error: 'press_requires_review', message: 'Tekanan ini perlu diperiksa operator — pilih tim pemenang lebih dulu.' },
            409,
          );
        const team = this.sql.exec<TeamRow>('SELECT * FROM teams WHERE id = ?', teamId).toArray()[0];
        if (!team) return this.json({ error: 'team_not_found' }, 404);
        const points = Math.max(0, Math.floor(Number(payload.points ?? round.points ?? meta.pointsPerRound)));
        const now = Date.now();
        this.sql.exec(
          "UPDATE rounds SET status = 'settled', awarded_team_id = ?, result = 'correct', points = ? WHERE id = ?",
          teamId,
          points,
          round.id,
        );
        if (attempt) this.sql.exec("UPDATE round_attempts SET status = 'settled' WHERE id = ?", attempt.id);
        this.sql.exec('UPDATE teams SET score = score + ? WHERE id = ?', points, teamId);
        this.sql.exec(
          'INSERT INTO score_edits (id, team_id, delta, reason, admin_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          newId('scr'),
          teamId,
          points,
          `ronde ${round.seq}`,
          adminId,
          now,
        );
        this.audit(adminId, 'settle', { roundSeq: round.seq, teamId, points });
        this.broadcast({ type: 'round.settled', round: this.roundInfo(round.id), scores: this.scores() });
        this.markTeamsChanged();
        return this.json({ ok: true, round: this.roundInfo(round.id) });
      }

      case 'next_candidate': {
        const round = this.latestRound();
        const attempt = round ? this.latestAttempt(round.id) : null;
        if (!attempt) return this.json({ error: 'no_attempt' }, 409);
        const ranking = this.attemptRanking(attempt).ranking;
        if (ranking.length === 0) return this.json({ error: 'empty_ranking' }, 409);
        const nextIdx = Math.min(attempt.candidate_idx + 1, ranking.length - 1);
        this.sql.exec('UPDATE round_attempts SET candidate_idx = ? WHERE id = ?', nextIdx, attempt.id);
        this.audit(adminId, 'next_candidate', { attemptId: attempt.id, candidateIdx: nextIdx });
        const teamId = ranking[nextIdx]?.teamId ?? null;
        this.broadcast({ type: 'attempt.candidate', candidateIdx: nextIdx, teamId });
        return this.json({ ok: true, candidateIdx: nextIdx, teamId });
      }

      case 'set_winner': {
        const round = this.latestRound();
        const attempt = round ? this.latestAttempt(round.id) : null;
        if (!attempt) return this.json({ error: 'no_attempt' }, 409);
        const ranking = this.attemptRanking(attempt).ranking;
        const teamId = String(payload.teamId ?? '');
        const idx = ranking.findIndex((r) => r.teamId === teamId);
        if (idx < 0) return this.json({ error: 'not_in_ranking' }, 400);
        this.sql.exec('UPDATE round_attempts SET candidate_idx = ? WHERE id = ?', idx, attempt.id);
        this.audit(adminId, 'set_winner', { attemptId: attempt.id, teamId, candidateIdx: idx });
        this.broadcast({ type: 'attempt.candidate', candidateIdx: idx, teamId });
        return this.json({ ok: true, candidateIdx: idx, teamId });
      }

      case 'void_round': {
        const round = this.latestRound();
        if (!round) return this.json({ error: 'no_round' }, 409);
        this.sql.exec("UPDATE rounds SET status = 'void', result = 'void' WHERE id = ?", round.id);
        this.sql.exec("UPDATE round_attempts SET status = 'void' WHERE round_id = ? AND status IN ('open','closed')", round.id);
        this.audit(adminId, 'void_round', { roundSeq: round.seq, reason: payload.reason ?? null });
        this.broadcast({ type: 'round.void', round: this.roundInfo(round.id) });
        return this.json({ ok: true, round: this.roundInfo(round.id) });
      }

      case 'score_edit': {
        const teamId = String(payload.teamId ?? '');
        const delta = Math.trunc(Number(payload.delta ?? 0));
        const reason = String(payload.reason ?? '').trim();
        if (!teamId || !Number.isFinite(delta) || delta === 0) return this.json({ error: 'bad_request' }, 400);
        if (reason.length < 3) return this.json({ error: 'reason_required' }, 400);
        const team = this.sql.exec<TeamRow>('SELECT * FROM teams WHERE id = ?', teamId).toArray()[0];
        if (!team) return this.json({ error: 'team_not_found' }, 404);
        this.sql.exec('UPDATE teams SET score = score + ? WHERE id = ?', delta, teamId);
        this.sql.exec(
          'INSERT INTO score_edits (id, team_id, delta, reason, admin_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          newId('scr'),
          teamId,
          delta,
          reason,
          adminId,
          Date.now(),
        );
        this.audit(adminId, 'score_edit', { teamId, delta, reason });
        this.markTeamsChanged();
        return this.json({ ok: true, scores: this.scores() });
      }

      case 'set_display_mode': {
        const mode = payload.mode as DisplayMode;
        if (!['top1', 'all'].includes(mode)) return this.json({ error: 'bad_mode' }, 400);
        const next = this.saveMeta({ displayMode: mode });
        this.audit(adminId, 'set_display_mode', { mode });
        this.broadcast({ type: 'display.mode', mode });
        this.broadcast({ type: 'event.updated', event: next });
        return this.json({ ok: true, event: next });
      }

      case 'set_status': {
        const status = payload.status as EventStatus;
        if (!['draft', 'open', 'live', 'closed'].includes(status)) return this.json({ error: 'bad_status' }, 400);
        const next = this.saveMeta({ status });
        this.audit(adminId, 'set_status', { status });
        this.broadcast({ type: 'event.updated', event: next });
        return this.json({ ok: true, event: next });
      }

      case 'start_event': {
        if (meta.status === 'live') return this.json({ error: 'already_started' }, 409);
        if (meta.status === 'finished') return this.json({ error: 'already_finished', message: 'Lomba sudah selesai.' }, 409);
        const next = this.saveMeta({ status: 'live' });
        this.audit(adminId, 'start_event', { teams: this.teams().length });
        this.broadcast({ type: 'event.updated', event: next });
        this.broadcast({ type: 'state', snapshot: this.snapshot('admin') }, { roles: ['admin'] });
        this.broadcast({ type: 'state', snapshot: this.snapshot('screen') }, { roles: ['screen', 'team'] });
        return this.json({ ok: true, event: next });
      }

      case 'finish_event': {
        if (meta.status === 'finished') return this.json({ error: 'already_finished', message: 'Lomba sudah selesai.' }, 409);
        const round = this.latestRound();
        const openRound = round && round.status === 'open' ? round : null;
        if (openRound) {
          // Ronde tanpa pemenang dicatat batal, bukan dihapus: riwayat tetap utuh.
          this.sql.exec("UPDATE rounds SET status = 'void', result = 'void' WHERE id = ?", openRound.id);
          this.sql.exec("UPDATE round_attempts SET status = 'void' WHERE round_id = ? AND status IN ('open','closed')", openRound.id);
          this.broadcast({ type: 'round.void', round: this.roundInfo(openRound.id) });
        }
        const next = this.saveMeta({ status: 'finished' });
        this.audit(adminId, 'finish_event', { teams: this.teams().length, roundSeq: openRound?.seq ?? null });
        this.broadcast({ type: 'event.updated', event: next });
        this.broadcast({ type: 'state', snapshot: this.snapshot('admin') }, { roles: ['admin'] });
        this.broadcast({ type: 'state', snapshot: this.snapshot('screen') }, { roles: ['screen', 'team'] });
        return this.json({ ok: true, event: next, voidedRound: openRound?.seq ?? null });
      }

      case 'kick_team': {
        if (meta.status !== 'open') return this.json({ error: 'registration_closed', message: 'Pendaftaran sudah ditutup.' }, 409);
        const teamId = String(payload.teamId ?? '');
        const team = this.sql.exec<TeamRow>('SELECT * FROM teams WHERE id = ?', teamId).toArray()[0];
        if (!team) return this.json({ error: 'team_not_found' }, 404);
        this.sql.exec('DELETE FROM presses WHERE team_id = ?', teamId);
        this.sql.exec('DELETE FROM score_edits WHERE team_id = ?', teamId);
        this.sql.exec('DELETE FROM teams WHERE id = ?', teamId);
        this.presence.delete(teamId);
        this.syncState.delete(teamId);
        this.lastPersist.delete(teamId);
        for (const ws of this.ctx.getWebSockets()) {
          const att = ws.deserializeAttachment() as Attachment | null;
          if (att?.teamId !== teamId) continue;
          this.send(ws, { type: 'hello.err', code: 'kicked', message: 'Dikeluarkan operator.' });
          try {
            ws.close(1008, 'kicked');
          } catch {
            // socket sudah tertutup
          }
        }
        this.audit(adminId, 'kick_team', { teamId, name: team.name });
        this.markTeamsChanged();
        this.broadcast({ type: 'state', snapshot: this.snapshot('admin') }, { roles: ['admin'] });
        this.broadcast({ type: 'state', snapshot: this.snapshot('screen') }, { roles: ['screen', 'team'] });
        return this.json({ ok: true });
      }

      default:
        return this.json({ error: 'unknown_action' }, 400);
    }
  }

  private createAttempt(roundId: string, idx: number, openAt: number): AttemptRow {
    const id = newId('att');
    const nonce = randomHex(8);
    this.sql.exec(
      `INSERT INTO round_attempts (id, round_id, idx, open_at, nonce, status, candidate_idx, created_at)
       VALUES (?, ?, ?, ?, ?, 'open', 0, ?)`,
      id,
      roundId,
      idx,
      openAt,
      nonce,
      Date.now(),
    );
    return this.sql.exec<AttemptRow>('SELECT * FROM round_attempts WHERE id = ?', id).one();
  }

  private resetBuzzer(adminId: string | null, reason: string): AttemptInfo {
    const meta = this.loadMeta();
    const round = this.latestRound();
    if (!round || round.status !== 'open') throw new Error('no_open_round');
    const previous = this.latestAttempt(round.id);
    if (previous && previous.status === 'open') {
      this.sql.exec("UPDATE round_attempts SET status = 'void' WHERE id = ?", previous.id);
    }
    const idx = (previous?.idx ?? -1) + 1;
    const attempt = this.createAttempt(round.id, idx, Date.now() + meta.leadMs);
    this.audit(adminId, 'reset_buzzer', { reason, attemptId: attempt.id, roundSeq: round.seq });
    this.broadcast({
      type: 'attempt.opened',
      attemptId: attempt.id,
      openAt: attempt.open_at,
      nonce: attempt.nonce,
      leadMs: meta.leadMs,
      roundSeq: round.seq,
    });
    return this.mapAttempt(attempt);
  }

  private mapAttempt(attempt: AttemptRow): AttemptInfo {
    return {
      id: attempt.id,
      roundId: attempt.round_id,
      idx: attempt.idx,
      openAt: attempt.open_at,
      closeAt: attempt.close_at,
      nonce: attempt.nonce,
      status: attempt.status,
      candidateIdx: attempt.candidate_idx,
    };
  }

  private roundInfo(roundId: string): RoundInfo | null {
    const round = this.sql.exec<RoundRow>('SELECT * FROM rounds WHERE id = ?', roundId).toArray()[0];
    if (!round) return null;
    return {
      id: round.id,
      seq: round.seq,
      status: round.status,
      awardedTeamId: round.awarded_team_id,
      result: round.result,
      points: round.points,
    };
  }

  private scores(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const team of this.teams()) out[team.id] = team.score;
    return out;
  }
}
