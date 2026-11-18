import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { AuditEntry, EventMeta, Snapshot, TeamPublic } from '@shared/protocol';
import { ApiError, api } from '../lib/api';
import { clearAdminToken, loadAdminEventId, loadAdminToken, saveAdminEventId, saveAdminToken } from '../lib/storage';
import { useEventSocket } from '../hooks/useEventSocket';
import { QrCode } from '../components/QrCode';
import { AppFooter, Chip, ConfirmDialog, LinkButton, LoadingRow, Metric, PageLoader, Panel, PasswordField, StatusDot, statusLabel } from '../components/ui';

interface AdminSummary {
  id: string;
  username: string;
  role: 'owner' | 'operator';
}

type ActionRunner = (action: string, payload?: Record<string, unknown>) => Promise<boolean>;

const AUDIT_LABEL: Record<string, string> = {
  open_round: 'Ronde dibuka',
  reset_buzzer: 'Tombol diulang',
  settle: 'Poin diberikan',
  next_candidate: 'Giliran dilempar',
  set_winner: 'Pemenang diubah',
  void_round: 'Ronde dibatalkan',
  score_edit: 'Skor disunting',
  set_display_mode: 'Mode papan skor diubah',
  set_status: 'Pendaftaran diubah',
  start_event: 'Lomba dimulai',
  kick_team: 'Tim dikeluarkan',
};
/** Ubah catatan audit menjadi satu kalimat yang bisa dibaca operator. */
function describeAudit(entry: AuditEntry, teams: TeamPublic[]): string {
  const label = AUDIT_LABEL[entry.action] ?? entry.action;
  const payload = (entry.payload && typeof entry.payload === 'object' ? entry.payload : {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof payload.name === 'string') parts.push(payload.name);
  else if (typeof payload.teamId === 'string') parts.push(teams.find((team) => team.id === payload.teamId)?.name ?? 'tim');
  const score = typeof payload.points === 'number' ? payload.points : typeof payload.delta === 'number' ? payload.delta : null;
  if (score !== null) parts.push(`${score > 0 ? '+' : ''}${score} poin`);
  if (typeof payload.roundSeq === 'number') parts.push(`ronde ${payload.roundSeq}`);
  if (payload.mode === 'all' || payload.mode === 'top1') parts.push(payload.mode === 'all' ? 'semua urutan' : 'hanya tercepat');
  if (payload.status === 'closed' || payload.status === 'open') parts.push(payload.status === 'closed' ? 'ditutup' : 'dibuka');
  if (payload.force === true) parts.push('paksa');
  if (typeof payload.reason === 'string' && payload.reason.trim()) parts.push(`alasan: ${payload.reason.trim()}`);
  return parts.length ? `${label} — ${parts.join(' · ')}` : label;
}

export function Admin() {
  const [token, setToken] = useState<string | null>(() => loadAdminToken());
  const [me, setMe] = useState<AdminSummary | null>(null);
  const [authError, setAuthError] = useState('');
  const [checking, setChecking] = useState(Boolean(token));

  useEffect(() => {
    if (!token) {
      setChecking(false);
      return;
    }
    let cancelled = false;
    api<{ admin: AdminSummary }>('/api/auth/me', {}, token)
      .then((response) => {
        if (!cancelled) setMe(response.admin);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          clearAdminToken();
          setToken(null);
          setAuthError('Sesi admin berakhir. Masuk ulang.');
        }
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const logout = async () => {
    if (token) await api('/api/auth/logout', { method: 'POST' }, token).catch(() => undefined);
    clearAdminToken();
    setToken(null);
    setMe(null);
  };

  if (checking) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <span className="label">memeriksa sesi…</span>
      </main>
    );
  }

  if (!token || !me) {
    return (
      <Login
        initialError={authError}
        onLogin={(nextToken, admin) => {
          saveAdminToken(nextToken);
          setToken(nextToken);
          setMe(admin);
          setAuthError('');
        }}
      />
    );
  }

  return <Console token={token} me={me} onLogout={logout} />;
}

function Login({ onLogin, initialError }: { onLogin: (token: string, admin: AdminSummary) => void; initialError: string }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api<{ token: string; admin: AdminSummary }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      onLogin(result.token, result.admin);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Gagal masuk.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[420px] flex-col justify-center px-5 py-10">
      <div className="label">Cerdas Cermat 2026</div>
      <h1 className="mt-2 text-[30px] leading-tight">Konsol operator</h1>
      <p className="mt-2 text-[13px] text-ink/60">Masuk untuk mengelola ronde dan skor.</p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <div>
          <label htmlFor="username" className="label">
            Nama pengguna
          </label>
          <input
            id="username"
            className="field mt-2"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </div>
        <div className="mt-2 pt-2">
          <PasswordField id="password" label="Sandi" value={password} onChange={setPassword} autoComplete="current-password" required />
        </div>
        {error ? (
          <div className="border-l-2 border-danger bg-danger/10 px-3 py-2 text-[13px] text-danger" role="alert">
            {error}
          </div>
        ) : null}
        <button type="submit" className="btn btn-primary btn-lg w-full" disabled={busy}>
          {busy ? 'Masuk…' : 'Masuk'}
        </button>
      </form>
      <div className="mt-5 flex items-center justify-between">
        <LinkButton href="/">Halaman peserta</LinkButton>
        <LinkButton href="/keadilan">Cara kerja</LinkButton>
      </div>
      <p className="mt-6 text-[12px] text-ink/40">Sesi berakhir otomatis setelah 12 jam.</p>
    </main>
  );
}

function Console({ token, me, onLogout }: { token: string; me: AdminSummary; onLogout: () => void }) {
  const [events, setEvents] = useState<EventMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() => loadAdminEventId());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [newEventName, setNewEventName] = useState('');
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [scoreTarget, setScoreTarget] = useState<{ id: string; name: string } | null>(null);
  const [forceArmed, setForceArmed] = useState(false);
  const [admins, setAdmins] = useState<AdminSummary[]>([]);
  const [adminForm, setAdminForm] = useState({ username: '', password: '', role: 'operator' as 'operator' | 'owner' });
  const [showAdmins, setShowAdmins] = useState(false);
  const [accountName, setAccountName] = useState(me.username);
  const [showAccount, setShowAccount] = useState(false);
  const [account, setAccount] = useState({ username: me.username, currentPassword: '', password: '' });
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmKick, setConfirmKick] = useState<{ id: string; name: string } | null>(null);
  /** Kandidat yang dipilih operator saat terjadi seri; terikat ke attempt tertentu. */
  const [tiePick, setTiePick] = useState<{ attemptId: string; teamId: string } | null>(null);

  const selected = useMemo(() => events.find((event) => event.id === selectedId) ?? null, [events, selectedId]);

  const loadEvents = useCallback(async () => {
    try {
      const response = await api<{ events: EventMeta[] }>('/api/events', {}, token);
      setEvents(response.events);
      setSelectedId((current) => {
        if (current && response.events.some((event) => event.id === current)) return current;
        return response.events[0]?.id ?? null;
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onLogout();
      else setError(err instanceof ApiError ? err.message : 'Gagal memuat lomba.');
    }
  }, [token, onLogout]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    if (selectedId) saveAdminEventId(selectedId);
  }, [selectedId]);

  const socket = useEventSocket({
    code: selected?.code,
    role: 'admin',
    token,
    enabled: Boolean(selected),
    onMessage: (message) => {
      if (message.type === 'hello.err') setError(message.message);
    },
  });

  const snapshot: Snapshot | null = socket.snapshot;

  const refresh = useCallback(async () => {
    if (!selectedId) return;
    try {
      const response = await api<{ snapshot: Snapshot }>(`/api/events/${selectedId}/state`, {}, token);
      socket.setSnapshot(response.snapshot);
    } catch {
      // biarkan WS yang menyegarkan; kegagalan polling tidak fatal
    }
  }, [selectedId, token, socket]);

  useEffect(() => {
    if (!selectedId) return;
    const timer = setInterval(() => void refresh(), 8000);
    return () => clearInterval(timer);
  }, [selectedId, refresh]);

  const run: ActionRunner = async (action, payload = {}) => {
    if (!selectedId) return false;
    setBusy(action);
    setError('');
    try {
      await api(`/api/events/${selectedId}/action`, { method: 'POST', body: JSON.stringify({ action, payload }) }, token);
      await refresh();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Aksi gagal.');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const createEvent = async (event: FormEvent) => {
    event.preventDefault();
    if (newEventName.trim().length < 3) return;
    setCreating(true);
    setError('');
    try {
      const response = await api<{ event: EventMeta }>('/api/events', { method: 'POST', body: JSON.stringify({ name: newEventName.trim() }) }, token);
      setNewEventName('');
      await loadEvents();
      setSelectedId(response.event.id);
      setNotice(`Lomba dibuat. Kode join: ${response.event.code}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Gagal membuat lomba.');
    } finally {
      setCreating(false);
    }
  };

  /** Ambil snapshot terbaru lalu susun laporan .xlsx di peramban (exceljs dimuat saat perlu). */
  const exportExcel = async () => {
    if (!selected) return;
    setExporting(true);
    try {
      const response = await api<{ snapshot: Snapshot }>(`/api/events/${selected.id}/state`, {}, token);
      const { downloadWorkbook } = await import('../lib/export');
      await downloadWorkbook(response.snapshot);
      setNotice('Laporan Excel diunduh.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ekspor gagal.');
    } finally {
      setExporting(false);
    }
  };

  /** Hapus lomba beserta seluruh data ronde, tim, dan skornya. */
  const removeEvent = async () => {
    if (!selected) return;
    if (snapshot?.event.status === 'live') {
      setConfirmDelete(false);
      setError('Lomba sudah dimulai. Hapus lomba tidak tersedia saat lomba berjalan.');
      return;
    }
    const target = selected;
    setDeleting(true);
    setError('');
    try {
      await api(`/api/events/${target.id}`, { method: 'DELETE' }, token);
      socket.setSnapshot(null);
      setSelectedId(null);
      await loadEvents();
      setConfirmDelete(false);
      setNotice(`Lomba ${target.name} dihapus.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Gagal menghapus lomba.');
    } finally {
      setDeleting(false);
    }
  };

  const loadAdmins = useCallback(async () => {
    try {
      const response = await api<{ admins: AdminSummary[] }>('/api/admins', {}, token);
      setAdmins(response.admins);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Gagal memuat admin.');
    }
  }, [token]);

  useEffect(() => {
    if (showAdmins && me.role === 'owner') void loadAdmins();
  }, [showAdmins, me.role, loadAdmins]);

  const addAdmin = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (adminForm.username.trim().length < 3) {
      setError('Nama pengguna minimal 3 karakter.');
      return;
    }
    if (adminForm.password.length < 8) {
      setError('Sandi minimal 8 karakter.');
      return;
    }
    try {
      await api('/api/admins', { method: 'POST', body: JSON.stringify(adminForm) }, token);
      setAdminForm({ username: '', password: '', role: 'operator' });
      await loadAdmins();
      setNotice('Admin ditambahkan.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Gagal menambah admin.');
    }
  };

  const removeAdmin = async (id: string) => {
    try {
      await api(`/api/admins/${id}`, { method: 'DELETE' }, token);
      await loadAdmins();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Gagal menghapus admin.');
    }
  };

  const saveAccount = async (event: FormEvent) => {
    event.preventDefault();
    setAccountError('');
    const username = account.username.trim();
    if (username.length < 3) {
      setAccountError('Nama pengguna minimal 3 karakter.');
      return;
    }
    if (account.password && account.password.length < 8) {
      setAccountError('Sandi baru minimal 8 karakter.');
      return;
    }
    if (!account.currentPassword) {
      setAccountError('Sandi saat ini wajib diisi.');
      return;
    }
    setAccountBusy(true);
    try {
      const response = await api<{ admin: AdminSummary; passwordChanged: boolean }>(
        '/api/admins',
        {
          method: 'PATCH',
          body: JSON.stringify({ username, password: account.password, currentPassword: account.currentPassword }),
        },
        token,
      );
      setAccountName(response.admin.username);
      setAccount({ username: response.admin.username, currentPassword: '', password: '' });
      if (showAdmins && me.role === 'owner') await loadAdmins();
      setShowAccount(false);
      setNotice(response.passwordChanged ? 'Nama pengguna dan sandi diperbarui.' : 'Nama pengguna diperbarui.');
    } catch (err) {
      setAccountError(err instanceof ApiError ? err.message : 'Gagal menyimpan.');
    } finally {
      setAccountBusy(false);
    }
  };

  const teams = snapshot?.teams ?? [];
  const ready = new Set(snapshot?.readyTeamIds ?? []);
  const online = teams.filter((team) => team.online).length;
  const ranking = snapshot?.ranking ?? [];
  const candidateId = snapshot?.candidateTeamId ?? null;
  const round = snapshot?.round ?? null;
  const attempt = snapshot?.attempt ?? null;
  /** Pilihan seri hanya berlaku untuk attempt yang sedang berjalan. */
  const tieChoice = tiePick && attempt && tiePick.attemptId === attempt.id ? tiePick.teamId : null;
  const tie = snapshot?.tie === true;
  const needsTieChoice = tie && !tieChoice;
  const allReady = teams.length > 0 && ready.size === teams.length;
  const registrationOpen = snapshot?.event.status === 'open';
  /** Lomba berjalan hanya setelah operator menekan "Mulai lomba". */
  const started = snapshot?.event.status === 'live';
  /** Snapshot dibuang saat lomba diganti, jadi kosong = sedang memuat. */
  const switching = Boolean(selected) && snapshot === null;
  const joinUrl = selected ? `${location.origin}/?code=${selected.code}` : '';

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="font-display text-[14px] tracking-[0.06em] uppercase">Cerdas Cermat 2026</span>
          {selected ? <span className="num chip text-[12px] tracking-[0.2em] text-signal">{selected.code}</span> : null}
        </div>
        <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2 text-[11px]">
          <span className="num text-ink/55">
            {teams.length} tim · {online} online · {ready.size} siap
          </span>
          <Chip tone={socket.status === 'open' ? 'ok' : 'danger'}>
            {socket.status === 'open' ? 'terhubung' : socket.status === 'connecting' ? 'menghubungkan' : 'terputus'}
          </Chip>
          <span className="text-ink/50" title={`peran: ${me.role}`}>
            {accountName}
          </span>
          <button type="button" className="link text-[12px]" onClick={onLogout}>
            Keluar
          </button>
        </div>
      </header>

      <div className="grid min-w-0 flex-1 grid-cols-1 gap-3 p-3 xl:grid-cols-12">
        <div className="min-w-0 space-y-3 xl:col-span-8">
          <Panel
            title="Pilih lomba"
            aside={selected ? `kode ${selected.code}` : 'belum ada'}
            bodyClassName="flex flex-wrap items-end gap-2 p-3"
          >
            <label className="min-w-[220px] flex-1">
              <span className="label">lomba</span>
              <select
                className="field mt-1 h-10 min-w-0 py-0"
                value={selectedId ?? ''}
                onChange={(e) => {
                  setSelectedId(e.target.value || null);
                  setNotice('');
                  setError('');
                  socket.setSnapshot(null);
                }}
              >
                {events.length === 0 ? <option value="">belum ada lomba</option> : null}
                {events.map((event) => (
                  <option key={event.id} value={event.id}>
                    {event.name} — {event.code}
                  </option>
                ))}
              </select>
            </label>
            <form onSubmit={createEvent} className="flex flex-1 items-end gap-2">
              <label className="min-w-[180px] flex-1">
                <span className="label">lomba baru</span>
                <input
                  className="field mt-1 h-10"
                  value={newEventName}
                  onChange={(e) => setNewEventName(e.target.value)}
                  placeholder="Cerdas Cermat Kecamatan 2026"
                />
              </label>
              <button type="submit" className="btn h-10" disabled={creating || newEventName.trim().length < 3}>
                {creating ? 'Membuat…' : 'Buat'}
              </button>
            </form>
            {selected ? (
              <div className="flex gap-2">
                <a className="btn h-10" href={`/screen?code=${selected.code}`} target="_blank" rel="noreferrer">
                  Layar
                </a>
                <button type="button" className="btn h-10" onClick={() => void exportExcel()} disabled={exporting}>
                  {exporting ? 'menyusun…' : 'Excel'}
                </button>
                {me.role === 'owner' ? (
                  <button
                    type="button"
                    className="btn btn-danger h-10"
                    onClick={() => setConfirmDelete(true)}
                    disabled={deleting || started}
                    title={started ? 'Lomba sudah dimulai — hapus dinonaktifkan.' : 'Hapus lomba ini'}
                  >
                    {deleting ? 'menghapus…' : 'Hapus'}
                  </button>
                ) : null}
              </div>
            ) : null}
            {switching ? (
              <div className="w-full border-t border-line">
                <LoadingRow text={`Memuat ${selected?.name ?? 'lomba'}…`} />
              </div>
            ) : null}
          </Panel>

          {error ? (
            <div className="border-l-2 border-danger bg-danger/10 px-3 py-2 text-[13px] text-danger" role="alert">
              {error}
            </div>
          ) : null}
          {notice ? (
            <div className="border-l-2 border-signal bg-signal/10 px-3 py-2 text-[13px] text-signal" role="status">
              {notice}
            </div>
          ) : null}

          {!selected ? (
            <Panel title="Belum ada lomba" bodyClassName="p-4 text-[13px] text-ink/60">
              Buat lomba dulu. Setelah dibuat, bagikan kode 6 karakter ke peserta.
            </Panel>
          ) : switching ? (
            <Panel title="Memuat lomba" bodyClassName="">
              <PageLoader compact title={`Mengambil data ${selected.name}`} hint="Menyiapkan tim, ronde, dan riwayat." />
            </Panel>
          ) : (
            <>
              <section className="panel">
                <div className="grid grid-cols-2 divide-x divide-line md:grid-cols-4">
                  <Metric label="Ronde" value={round ? `${round.seq} · ${statusLabel(round.status)}` : '—'} />
                  <Metric label="Siap" value={`${ready.size}/${teams.length}`} tone={allReady ? 'ok' : 'gold'} />
                  <Metric label="Status" value={statusLabel(attempt?.status ?? round?.status ?? 'idle')} tone={attempt?.status === 'open' ? 'signal' : 'default'} />
                  <Metric label="Mode" value={snapshot?.event.displayMode === 'all' ? 'semua urutan' : 'hanya tercepat'} />
                </div>
                <div className="flex flex-wrap items-center gap-2 border-t border-line p-3">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy !== null || !started}
                    title={started ? 'Buka rebutan' : 'Tekan “Mulai lomba” dulu.'}
                    onClick={async () => {
                      const ok = await run('open_round', { force: forceArmed });
                      if (ok) {
                        setForceArmed(false);
                        setNotice(forceArmed ? 'Ronde dibuka paksa.' : 'Rebutan dibuka.');
                      }
                    }}
                  >
                    {busy === 'open_round' ? '…' : 'Buka rebutan'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy !== null || !started || !round || round.status !== 'open'}
                    onClick={async () => {
                      const ok = await run('reset_buzzer');
                      if (ok) setNotice('Tombol diulang.');
                    }}
                  >
                    {busy === 'reset_buzzer' ? '…' : 'Reset tombol'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={busy !== null || !started || !round || round.status !== 'open'}
                    onClick={async () => {
                      const ok = await run('void_round', { reason: 'dibatalkan operator' });
                      if (ok) setNotice('Ronde dibatalkan.');
                    }}
                  >
                    Batalkan ronde
                  </button>
                  <button
                    type="button"
                    className={`btn h-8 min-h-0 px-2 text-[11px] ${forceArmed ? 'border-gold text-gold' : ''}`}
                    disabled={busy !== null || !started}
                    onClick={() => setForceArmed((value) => !value)}
                    title="Buka walau ada tim belum siap"
                  >
                    {forceArmed ? 'paksa aktif' : 'buka paksa'}
                  </button>
                  <div className="ml-auto flex items-center gap-2">
                    <span className="label">pendaftaran</span>
                    <Chip tone={registrationOpen ? 'ok' : 'default'}>{registrationOpen ? 'terbuka' : 'ditutup'}</Chip>
                  </div>
                </div>
                {!started ? (
                  <div className="border-t border-line px-3 py-2 text-[12px] text-gold">
                    Rebutan dan kontrol ronde aktif setelah lomba dimulai.
                  </div>
                ) : null}
                {!allReady && teams.length > 0 ? (
                  <div className="border-t border-line px-3 py-2 text-[12px] text-gold">
                    {teams.length - ready.size} tim belum siap.
                  </div>
                ) : null}
              </section>

              <Panel
                title="Lobi peserta"
                aside={registrationOpen ? 'pendaftaran terbuka' : 'pendaftaran tertutup'}
                bodyClassName="grid gap-3 p-3 sm:grid-cols-[auto_1fr]"
              >
                <div className="justify-self-start bg-ink p-2">
                  <QrCode text={joinUrl} size={116} />
                </div>
                <div className="min-w-0 space-y-2">
                  <div>
                    <div className="label">kode lomba</div>
                    <div className="num mt-1 text-[22px] leading-none tracking-[0.2em] text-signal">{selected.code}</div>
                  </div>
                  <a className="link block truncate text-[11px]" href={joinUrl} target="_blank" rel="noreferrer">
                    {joinUrl}
                  </a>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button
                      type="button"
                      className="btn btn-primary h-9 min-h-0"
                      disabled={busy !== null || !registrationOpen}
                      onClick={async () => {
                        const ok = await run('start_event');
                        if (ok) setNotice('Lomba dimulai. Pendaftaran ditutup.');
                      }}
                    >
                      {busy === 'start_event' ? 'memulai…' : 'Mulai lomba'}
                    </button>
                    {registrationOpen ? (
                      <button
                        type="button"
                        className="btn h-9 min-h-0"
                        disabled={busy !== null}
                        onClick={async () => {
                          const ok = await run('set_status', { status: 'closed' });
                          if (ok) setNotice('Pendaftaran ditutup.');
                        }}
                      >
                        {busy === 'set_status' ? '…' : 'Tutup pendaftaran'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn h-9 min-h-0"
                        disabled={busy !== null}
                        onClick={() => void run('set_status', { status: 'open' })}
                      >
                        Buka pendaftaran
                      </button>
                    )}
                  </div>
                  <p className="text-[11px] text-ink/50">
                    {registrationOpen
                      ? 'Peserta memindai QR di layar untuk mendaftar. Salah masuk? Keluarkan lewat tabel di bawah.'
                      : 'Pendaftaran ditutup. Peserta baru ditolak server sampai pendaftaran dibuka lagi.'}
                  </p>
                </div>
              </Panel>

              <Panel
                title={attempt ? `Hasil percobaan #${attempt.idx + 1}` : 'Hasil percobaan'}
                aside={
                  attempt?.closeAt
                    ? `ditutup ${new Date(attempt.closeAt).toLocaleTimeString('id-ID')}`
                    : ranking.length
                      ? `${ranking.length} tim menekan`
                      : 'belum ada tekan'
                }
                bodyClassName=""
              >
                {snapshot?.tie ? (
                  <div className="border-b border-gold/40 bg-gold/10 px-3 py-2 text-[12px] text-gold">
                    Seri: selisih dua tekan terlalu kecil. Pilih kandidat yang menang (tombol “kandidat”) sebelum memberi poin.
                  </div>
                ) : null}
                {ranking.length === 0 ? (
                  <div className="p-4 text-[13px] text-ink/55">
                    {attempt?.status === 'open' ? 'Menunggu tekanan pertama.' : 'Belum ada tekanan tercatat.'}
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table data-testid="ranking" className="w-full text-left text-[13px]">
                      <thead>
                        <tr className="border-b border-line text-ink/50">
                          <th className="label px-3 py-2 font-normal">#</th>
                          <th className="label px-3 py-2 font-normal">tim</th>
                          <th className="label px-3 py-2 font-normal">selisih</th>
                          <th className="label hidden px-3 py-2 font-normal md:table-cell">catatan</th>
                          <th className="label px-3 py-2 font-normal"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {ranking.map((row) => {
                          const isCandidate = row.teamId === candidateId;
                          return (
                            <tr key={row.teamId} className={`row ${isCandidate ? 'bg-gold/[0.07]' : ''}`}>
                              <td className={`num px-3 py-2 ${isCandidate ? 'border-l-2 border-gold text-gold' : 'border-l-2 border-transparent text-ink/50'}`}>
                                {row.rank}
                              </td>
                              <td className="px-3 py-2">
                                <span className="flex items-center gap-2">
                                  {row.name}
                                  {isCandidate ? (
                                    <span className="hidden sm:inline-flex">
                                      <Chip tone="gold">kandidat</Chip>
                                    </span>
                                  ) : null}
                                </span>
                              </td>
                              <td className="num px-3 py-2 text-ink/70">{row.rank === 1 ? '0 ms' : `+${Math.round(row.gapMs)} ms`}</td>
                              <td className="hidden px-3 py-2 md:table-cell">
                                {row.flags.length ? <span className="text-[11px] text-danger">perlu diperiksa</span> : <span className="text-ink/25">—</span>}
                              </td>
                              <td className="px-3 py-2 text-right whitespace-nowrap">
                                <button
                                  type="button"
                                  className="btn h-7 min-h-0 px-2 text-[10px] whitespace-nowrap"
                                  disabled={busy !== null || row.teamId === candidateId}
                                  title={`Jadikan ${row.name} kandidat aktif`}
                                  onClick={() => {
                                    if (attempt) setTiePick({ attemptId: attempt.id, teamId: row.teamId });
                                    void run('set_winner', { teamId: row.teamId });
                                  }}
                                >
                                  kandidat
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2 border-t border-line p-3">
                  <button
                    type="button"
                    className="btn btn-gold"
                    disabled={busy !== null || !round || round.status !== 'open' || !candidateId || needsTieChoice}
                    title={needsTieChoice ? 'Hasil seri: pilih kandidat pemenang lebih dulu.' : undefined}
                    onClick={async () => {
                      const teamId = needsTieChoice ? null : tie ? tieChoice : candidateId;
                      if (!teamId) return;
                      const ok = await run('settle', tie ? { teamId, explicit: true } : { teamId });
                      if (ok) {
                        setTiePick(null);
                        setNotice('Poin diberikan ke kandidat aktif.');
                      }
                    }}
                  >
                    Beri poin +{round?.points ?? snapshot?.event.pointsPerRound ?? 100}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy !== null || !attempt || ranking.length === 0}
                    onClick={async () => {
                      const ok = await run('next_candidate');
                      if (ok) setNotice('Giliran dilempar ke penekan berikutnya.');
                    }}
                  >
                    Tidak bisa → lempar
                  </button>
                </div>
              </Panel>

              <Panel title="Tim & skor" aside={`${teams.length} tim · ${online} online`} bodyClassName="overflow-x-auto">
                <table className="w-full text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-ink/50">
                      <th className="label px-3 py-2 font-normal">tim</th>
                      <th className="label px-3 py-2 font-normal">status</th>
                      <th className="label px-3 py-2 text-right font-normal">skor</th>
                      <th className="label px-3 py-2 text-right font-normal">ubah</th>
                      {registrationOpen ? <th className="label px-3 py-2 text-right font-normal">keluarkan</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {teams.map((team) => (
                      <tr key={team.id} className="row">
                        <td className="px-3 py-2">
                          <span className="flex items-center gap-2">
                            <StatusDot state={team.online ? (ready.has(team.id) ? 'ok' : 'warn') : 'bad'} />
                            <span className="block max-w-[8.5rem] truncate sm:max-w-none">{team.name}</span>
                          </span>
                        </td>
                        <td className="num px-3 py-2 text-[11px] text-ink/60">{team.online ? (ready.has(team.id) ? 'siap' : 'online') : 'terputus'}</td>
                        <td className="num px-3 py-2 text-[14px] font-bold">{team.score}</td>
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            className="btn h-7 min-h-0 px-2 text-[11px]"
                            onClick={() => setScoreTarget({ id: team.id, name: team.name })}
                          >
                            ubah poin
                          </button>
                        </td>
                        {registrationOpen ? (
                          <td className="px-3 py-2 text-right">
                            <button
                              type="button"
                              className="btn btn-danger h-7 min-h-0 px-2 text-[11px]"
                              disabled={busy !== null}
                              onClick={() => setConfirmKick({ id: team.id, name: team.name })}
                            >
                              {busy === 'kick_team' ? '…' : 'keluarkan'}
                            </button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                    {teams.length === 0 ? (
                      <tr>
                        <td colSpan={registrationOpen ? 5 : 4} className="px-3 py-4 text-[13px] text-ink/50">
                          Belum ada tim mendaftar. Bagikan kode {selected.code}.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </Panel>
            </>
          )}
        </div>

        <div className="min-w-0 space-y-3 xl:col-span-4">
          <Panel title="Kesiapan" aside={selected ? `${ready.size}/${teams.length}` : ''} bodyClassName="">
            {teams.length === 0 ? (
              <p className="p-3 text-[13px] text-ink/45">Belum ada tim terdaftar.</p>
            ) : ready.size === teams.length ? (
              <p className="p-3 text-[13px] text-ok">Semua tim siap.</p>
            ) : (
              <ul>
                {teams
                  .filter((team) => !ready.has(team.id))
                  .slice(0, 8)
                  .map((team) => (
                    <li key={team.id} className="row flex items-center justify-between gap-2 px-3 py-2 text-[12px]">
                      <span className="truncate">{team.name}</span>
                      <span className="num shrink-0 text-[11px] text-ink/45">{team.online ? 'belum siap' : 'terputus'}</span>
                    </li>
                  ))}
              </ul>
            )}
          </Panel>

          <Panel title="Mode tampilan" bodyClassName="">
            <div className="grid grid-cols-2 divide-x divide-line">
              {(['top1', 'all'] as const).map((mode) => {
                const active = snapshot?.event.displayMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    className={`px-3 py-3 text-left transition-colors ${active ? 'text-signal' : 'text-ink/55 hover:text-ink'}`}
                    onClick={() => void run('set_display_mode', { mode })}
                  >
                    <span className="label" style={{ color: 'currentColor' }}>
                      {mode === 'top1' ? 'hanya tercepat' : 'semua urutan'}
                    </span>
                    <span className="mt-1 block h-0.5 w-8" style={{ background: active ? 'currentColor' : 'transparent' }} />
                  </button>
                );
              })}
            </div>
            <p className="border-t border-line px-3 py-2 text-[11px] leading-snug text-ink/50">
              Mengatur daftar “urutan tekan” di layar papan skor dan di HP peserta: hanya penekan tercepat, atau seluruh urutan.
            </p>
          </Panel>

          <Panel title="Riwayat aksi" aside="40 terakhir" bodyClassName="">
            <ul className="max-h-[260px] overflow-auto">
              {(snapshot?.audit ?? []).map((entry) => (
                <li key={entry.id} className="row flex items-baseline gap-2 px-3 py-1.5 text-[11px]">
                  <span className="num shrink-0 text-ink/40">{new Date(entry.createdAt).toLocaleTimeString('id-ID')}</span>
                  <span className="min-w-0 break-words text-ink/80">{describeAudit(entry, teams)}</span>
                </li>
              ))}
              {(snapshot?.audit ?? []).length === 0 ? <li className="px-3 py-3 text-[12px] text-ink/45">Belum ada aksi tercatat.</li> : null}
            </ul>
          </Panel>

          <Panel title="Koneksi" bodyClassName="space-y-2 p-3 text-[11px]">
            <p className="text-[12px] text-ink/60">
              {socket.status === 'open' ? 'Tersambung.' : 'Terputus. Sambung ulang dulu.'}
            </p>
            <button
              type="button"
              className="btn h-8 min-h-0 w-full text-[11px]"
              onClick={() => {
                // satu tombol untuk dua kebutuhan operator: sambung lagi bila putus, lalu ambil data terbaru
                if (socket.status !== 'open') socket.reconnect();
                void refresh();
              }}
            >
              Muat ulang
            </button>
          </Panel>

          <Panel
            title="Akun saya"
            aside={
              <button
                type="button"
                className="link text-[11px]"
                onClick={() => {
                  setShowAccount((value) => !value);
                  setAccountError('');
                }}
              >
                {showAccount ? 'tutup' : 'ubah'}
              </button>
            }
            bodyClassName=""
          >
            {showAccount ? (
              <form onSubmit={saveAccount} className="space-y-2 p-3">
                <label className="block">
                  <span className="label">nama pengguna</span>
                  <input
                    className="field mt-1 h-9 text-[13px]"
                    value={account.username}
                    onChange={(e) => setAccount({ ...account, username: e.target.value })}
                    autoComplete="username"
                    required
                  />
                </label>
                <PasswordField
                  id="account-current-password"
                  label="sandi saat ini"
                  value={account.currentPassword}
                  onChange={(value) => setAccount({ ...account, currentPassword: value })}
                  autoComplete="current-password"
                  required
                  className="h-9 text-[13px]"
                />
                <PasswordField
                  id="account-new-password"
                  label="sandi baru"
                  value={account.password}
                  onChange={(value) => setAccount({ ...account, password: value })}
                  placeholder="kosongkan bila tetap"
                  autoComplete="new-password"
                  className="h-9 text-[13px]"
                />
                {accountError ? <p className="text-[12px] text-danger">{accountError}</p> : null}
                <button type="submit" className="btn h-9 min-h-0 w-full text-[11px]" disabled={accountBusy}>
                  {accountBusy ? 'menyimpan…' : 'simpan'}
                </button>
              </form>
            ) : (
              <p className="p-3 text-[12px] text-ink/50">
                {accountName} · {me.role}
              </p>
            )}
          </Panel>

          {me.role === 'owner' ? (
            <Panel
              title="Admin"
              aside={<button type="button" className="link text-[11px]" onClick={() => setShowAdmins((v) => !v)}>{showAdmins ? 'tutup' : 'kelola'}</button>}
              bodyClassName=""
            >
              {showAdmins ? (
                <div className="p-3">
                  <ul className="mb-3 divide-y divide-line-soft">
                    {admins.map((admin) => (
                      <li key={admin.id} className="flex items-center justify-between gap-2 py-1.5 text-[12px]">
                        <span>
                          {admin.username} <span className="num text-[10px] text-ink/40">{admin.role}</span>
                        </span>
                        <button
                          type="button"
                          className="btn btn-danger h-6 min-h-0 px-2 text-[10px]"
                          disabled={admin.id === me.id}
                          onClick={() => void removeAdmin(admin.id)}
                        >
                          hapus
                        </button>
                      </li>
                    ))}
                  </ul>
                  <form onSubmit={addAdmin} noValidate className="space-y-2">
                    <input
                      className="field h-9 text-[13px]"
                      placeholder="nama pengguna baru"
                      value={adminForm.username}
                      onChange={(e) => setAdminForm({ ...adminForm, username: e.target.value })}
                      required
                    />
                    <PasswordField
                      id="admin-new-password"
                      label="sandi admin baru"
                      value={adminForm.password}
                      onChange={(value) => setAdminForm({ ...adminForm, password: value })}
                      placeholder="sandi minimal 8 karakter"
                      autoComplete="new-password"
                      required
                      className="h-9 text-[13px]"
                    />
                    <div className="flex gap-2">
                      <select
                        className="field h-9 min-w-0 flex-1 text-[13px]"
                        value={adminForm.role}
                        onChange={(e) => setAdminForm({ ...adminForm, role: e.target.value as 'operator' | 'owner' })}
                        aria-label="peran admin baru"
                      >
                        <option value="operator">operator</option>
                        <option value="owner">owner</option>
                      </select>
                      <button
                        type="submit"
                        className="btn h-9 min-h-0 px-3 text-[11px]"
                        disabled={adminForm.username.trim().length < 3 || adminForm.password.length < 8}
                      >
                        tambah
                      </button>
                    </div>
                  </form>
                </div>
              ) : (
                <p className="p-3 text-[12px] text-ink/50">Owner menambah operator lewat panel ini.</p>
              )}
            </Panel>
          ) : null}

          <Panel title="Pintasan" bodyClassName="flex flex-wrap gap-2 p-3">
            <LinkButton href="/">Halaman peserta</LinkButton>
            <LinkButton href="/keadilan">Halaman keadilan</LinkButton>
            {selected ? (
              <a className="link text-[12px]" href={`/?code=${selected.code}`} target="_blank" rel="noreferrer">
                Form pendaftaran
              </a>
            ) : null}
          </Panel>
        </div>
      </div>

      {scoreTarget ? (
        <ScoreEditor
          team={scoreTarget}
          onClose={() => setScoreTarget(null)}
          onSubmit={async (delta, reason) => {
            const ok = await run('score_edit', { teamId: scoreTarget.id, delta, reason });
            if (ok) {
              setNotice(`Skor ${scoreTarget.name} disesuaikan ${delta > 0 ? '+' : ''}${delta}.`);
              setScoreTarget(null);
            }
            return ok;
          }}
        />
      ) : null}

      {confirmKick ? (
        <ConfirmDialog
          title="Keluarkan peserta"
          message={`Keluarkan "${confirmKick.name}" dari pendaftaran? Tim ini harus mendaftar ulang untuk ikut.`}
          confirmLabel={busy === 'kick_team' ? 'Mengeluarkan…' : 'Ya, keluarkan'}
          busy={busy === 'kick_team'}
          onCancel={() => setConfirmKick(null)}
          onConfirm={async () => {
            const ok = await run('kick_team', { teamId: confirmKick.id });
            if (ok) setNotice(`${confirmKick.name} dikeluarkan.`);
            setConfirmKick(null);
          }}
        />
      ) : null}

      {confirmDelete && selected ? (
        <ConfirmDialog
          title="Hapus lomba"
          message={`Hapus "${selected.name}" beserta seluruh tim, skor, dan riwayat ronde? Tindakan ini tidak bisa dibatalkan.`}
          confirmLabel={deleting ? 'Menghapus…' : 'Hapus lomba'}
          busy={deleting}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void removeEvent()}
        />
      ) : null}

      <AppFooter note={selected ? `lomba ${selected.name}` : 'pilih atau buat lomba untuk mulai'} />
    </div>
  );
}

function ScoreEditor({
  team,
  onClose,
  onSubmit,
}: {
  team: { id: string; name: string };
  onClose: () => void;
  onSubmit: (delta: number, reason: string) => Promise<boolean>;
}) {
  const [delta, setDelta] = useState('10');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 p-4 sm:items-center" role="dialog" aria-modal="true">
      <form
        className="w-full max-w-[420px] border border-line bg-panel p-4"
        onSubmit={async (event) => {
          event.preventDefault();
          const value = Number(delta);
          if (!Number.isFinite(value) || value === 0) {
            setError('Masukkan angka bukan nol.');
            return;
          }
          if (reason.trim().length < 3) {
            setError('Alasan wajib diisi (minimal 3 karakter).');
            return;
          }
          setBusy(true);
          const ok = await onSubmit(Math.trunc(value), reason.trim());
          setBusy(false);
          if (!ok) setError('Gagal menyimpan. Coba lagi.');
        }}
      >
        <div className="label">edit skor · {team.name}</div>
        <label className="mt-3 block">
          <span className="label">delta</span>
          <input className="field mt-1" value={delta} onChange={(e) => setDelta(e.target.value)} inputMode="numeric" autoFocus />
        </label>
        <label className="mt-3 block">
          <span className="label">alasan</span>
          <input
            className="field mt-1"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Contoh: koreksi poin ronde 3"
          />
        </label>
        {error ? <p className="mt-2 text-[12px] text-danger">{error}</p> : null}
        <div className="mt-4 flex gap-2">
          <button type="submit" className="btn btn-primary flex-1" disabled={busy}>
            {busy ? 'Menyimpan…' : 'Simpan'}
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Batal
          </button>
        </div>
      </form>
    </div>
  );
}
