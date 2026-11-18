import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from '../lib/api';
import { loadTeamSession, saveTeamSession, clearTeamSession, loadLastTeam, clearLastTeam, type TeamSession } from '../lib/storage';
import { AppFooter, ConfirmDialog, LinkButton, LoadingRow, StatusDot, navigate } from '../components/ui';
import type { EventStatus, JoinResult } from '@shared/protocol';

const CODE_RE = /[^A-Z0-9]/g;

export function Join() {
  const [existing, setExisting] = useState<TeamSession | null>(() => loadTeamSession());
  // Tim terakhir tetap tersimpan walau sesi aktif sudah dilepas, supaya peserta
  // yang menekan "Keluar tim" bisa masuk kembali tanpa meminta token ke operator.
  const [last, setLast] = useState<TeamSession | null>(() => (loadTeamSession() ? null : loadLastTeam()));
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [lookup, setLookup] = useState<{ status: EventStatus; teams: number } | null>(null);
  const [looking, setLooking] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const fromQuery = (params.get('code') ?? '').toUpperCase().replace(CODE_RE, '').slice(0, 6);
    if (fromQuery) setCode(fromQuery);
  }, []);

  // Cek status lomba sebelum mengetik nama, supaya peserta tidak mengisi form yang sudah ditutup.
  useEffect(() => {
    const clean = code.toUpperCase().replace(CODE_RE, '');
    if (clean.length !== 6) {
      setLookup(null);
      setLooking(false);
      return;
    }
    let alive = true;
    setLooking(true);
    const timer = setTimeout(() => {
      api<{ event: { status: EventStatus }; teamCount: number }>(`/api/public/events/${clean}`)
        .then((response) => {
          if (!alive) return;
          setLookup({ status: response.event.status, teams: response.teamCount });
        })
        .catch(() => {
          if (alive) setLookup(null);
        })
        .finally(() => {
          if (alive) setLooking(false);
        });
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [code]);

  const closed = lookup !== null && lookup.status !== 'open';
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const enter = (session: TeamSession) => {
    saveTeamSession(session);
    navigate(`/t/${session.teamId}`);
  };

  const register = async (cleanCode: string, cleanName: string) => {
    setBusy(true);
    try {
      const result = await api<JoinResult>('/api/join', {
        method: 'POST',
        body: JSON.stringify({ code: cleanCode, teamName: cleanName }),
      });
      enter({ ...result, joinedAt: Date.now() });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Pendaftaran gagal. Coba lagi.');
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    const cleanCode = code.toUpperCase().replace(CODE_RE, '');
    const cleanName = name.replace(/\s+/g, ' ').trim();
    if (cleanCode.length !== 6) {
      setError('Kode lomba harus 6 karakter.');
      return;
    }
    if (cleanName.length < 2) {
      setError('Nama tim minimal 2 karakter.');
      return;
    }
    // Kode lomba yang sama dengan tim tersimpan: tawarkan masuk kembali dulu,
    // jangan langsung mendaftar (nama lama akan ditolak server sebagai name_taken).
    if (last && last.eventCode === cleanCode) {
      setPendingName(cleanName);
      return;
    }
    await register(cleanCode, cleanName);
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col px-5 py-8">
      <header>
        <div className="label">Cerdas Cermat 2026</div>
        <h1 className="mt-3 text-[34px] leading-[1.05] tracking-[-0.03em]">Daftar tim</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-ink/65">
          Isi kode lomba dari operator, lalu daftar dengan nama tim.
        </p>
      </header>

      {existing ? (
        <div className="mt-6 border border-line bg-panel p-4">
          <div className="label">Terdaftar di perangkat ini</div>
          <div className="mt-2 flex items-baseline justify-between gap-3">
            <div>
              <div className="font-display text-[20px] leading-tight">{existing.teamName}</div>
              <div className="num mt-1 text-[12px] text-ink/55">
                {existing.eventName} · {existing.eventCode}
              </div>
            </div>
            <StatusDot state="ok" />
          </div>
          <div className="mt-4 flex gap-2">
            <button type="button" className="btn btn-primary flex-1" onClick={() => navigate(`/t/${existing.teamId}`)}>
              Lanjut
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                clearTeamSession();
                setExisting(null);
                setLast(loadLastTeam());
              }}
            >
              Keluar
            </button>
          </div>
        </div>
      ) : null}

      {!existing && last ? (
        <div className="mt-6 border border-line bg-panel p-4">
          <div className="label">Tim tersimpan di perangkat ini</div>
          <div className="mt-2 flex items-baseline justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate font-display text-[20px] leading-tight">{last.teamName}</div>
              <div className="num mt-1 text-[12px] text-ink/55">
                {last.eventName} · {last.eventCode}
              </div>
            </div>
            <StatusDot state="ok" />
          </div>
          <div className="mt-4 flex gap-2">
            <button type="button" className="btn btn-primary flex-1" onClick={() => enter(last)}>
              Masuk kembali
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                clearLastTeam();
                setLast(null);
              }}
            >
              Lupakan
            </button>
          </div>
        </div>
      ) : null}

      <form onSubmit={submit} className="mt-6 space-y-5">
        <div>
          <label htmlFor="code" className="label">
            Kode lomba
          </label>
          <input
            id="code"
            className="field field-code mt-2"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(CODE_RE, '').slice(0, 6))}
            placeholder="K7M2QX"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            maxLength={6}
            required
          />
          {looking ? (
            <div className="mt-1.5">
              <LoadingRow text="memeriksa kode…" />
            </div>
          ) : lookup ? (
            <p className={`mt-1.5 text-[12px] ${closed ? 'text-danger' : 'text-ok'}`}>
              {closed ? 'Pendaftaran lomba ini sudah ditutup.' : `${lookup.teams} tim sudah mendaftar · pendaftaran dibuka`}
            </p>
          ) : (
            <p className="mt-1.5 text-[12px] text-ink/45">6 karakter.</p>
          )}
        </div>
        <div>
          <label htmlFor="name" className="label">
            Nama tim
          </label>
          <input
            id="name"
            className="field mt-2"
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 32))}
            placeholder="Contoh: SMPN 1 Sinjai — Tim A"
            autoComplete="off"
            maxLength={32}
            required
          />
          <p className="mt-1.5 text-[12px] text-ink/45">Tampil di papan skor.</p>
        </div>

        {error ? (
          <div className="border-l-2 border-danger bg-danger/10 px-3 py-2 text-[13px] text-danger" role="alert">
            {error}
          </div>
        ) : null}

        <button type="submit" className="btn btn-primary btn-lg w-full" disabled={busy || closed || code.length !== 6 || name.trim().length < 2}>
          {busy ? 'Mendaftar…' : 'Daftar & masuk'}
        </button>
      </form>

      <div className="mt-5 flex items-center justify-between">
        <LinkButton href="/keadilan">Cara penilaian</LinkButton>
        <LinkButton href="/admin">Admin</LinkButton>
      </div>

      <div className="mt-auto pt-8">
        <AppFooter note="Satu kode untuk semua tim." />
      </div>

      {pendingName && last ? (
        <ConfirmDialog
          title={
            pendingName.toLowerCase() === last.teamName.toLowerCase() ? 'Tim ini sudah terdaftar' : 'Kode cocok dengan tim tersimpan'
          }
          message={
            pendingName.toLowerCase() === last.teamName.toLowerCase() ? (
              <>
                Nama <strong className="text-ink">{last.teamName}</strong> sudah dipakai di perangkat ini. Masuk kembali ke tim
                itu?
              </>
            ) : (
              <>
                Kode <span className="num text-ink">{last.eventCode}</span> sudah terhubung dengan tim{' '}
                <strong className="text-ink">{last.teamName}</strong> di perangkat ini. Masuk kembali sebagai tim itu, atau
                daftar sebagai tim baru bernama <strong className="text-ink">{pendingName}</strong>?
              </>
            )
          }
          confirmLabel={`Masuk sebagai ${last.teamName}`}
          confirmTone="primary"
          secondaryLabel={pendingName.toLowerCase() === last.teamName.toLowerCase() ? undefined : 'Daftar tim baru'}
          onSecondary={
            pendingName.toLowerCase() === last.teamName.toLowerCase()
              ? undefined
              : () => {
                  const nextName = pendingName;
                  setPendingName(null);
                  void register(last.eventCode, nextName);
                }
          }
          busy={busy}
          onCancel={() => setPendingName(null)}
          onConfirm={() => enter(last)}
        />
      ) : null}
    </main>
  );
}
