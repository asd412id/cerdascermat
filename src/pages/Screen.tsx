import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Snapshot } from '@shared/protocol';
import { useEventSocket } from '../hooks/useEventSocket';
import { QrCode } from '../components/QrCode';
import { Chip, PageLoader, StatusDot, statusLabel } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { loadScreenCode, saveScreenCode } from '../lib/storage';

export function ScreenBoard() {
  const [activeCode, setActiveCode] = useState<string | null>(() => {
    const fromQuery = (new URLSearchParams(location.search).get('code') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    return fromQuery || loadScreenCode();
  });
  const [input, setInput] = useState('');
  /** Kode lomba tidak ada di server (mis. lomba sudah dihapus operator). */
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (activeCode) saveScreenCode(activeCode);
  }, [activeCode]);

  // Socket ke kode yang tidak ada hanya akan putus-nyambung tanpa henti, jadi
  // ketersediaan lomba dicek lewat HTTP: 404 = tampilkan layar "tidak tersedia".
  const probe = useCallback(async (code: string) => {
    try {
      await api(`/api/public/events/${code}`);
      setMissing(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setMissing(true);
    }
  }, []);

  useEffect(() => {
    if (!activeCode) {
      setMissing(false);
      return;
    }
    setMissing(false);
    void probe(activeCode);
  }, [activeCode, probe]);

  const socket = useEventSocket({
    code: activeCode ?? undefined,
    role: 'screen',
    enabled: !missing,
    onMessage: (message) => {
      // Lomba dihapus operator: layar kembali ke pintu masuk kode, jangan
      // menampilkan klasemen lomba yang sudah tidak ada.
      if (message.type === 'hello.err' && message.code === 'deleted') {
        saveScreenCode('');
        setActiveCode(null);
        setInput('');
        setMissing(false);
      }
    },
  });

  // Lomba bisa dihapus saat layar sedang terbuka: socket putus, lalu dicek ulang.
  useEffect(() => {
    if (!activeCode || missing || socket.snapshot || socket.status !== 'closed') return;
    const timer = setTimeout(() => void probe(activeCode), 1500);
    return () => clearTimeout(timer);
  }, [activeCode, missing, probe, socket.snapshot, socket.status]);

  if (!activeCode) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-[420px] flex-col justify-center px-5">
        <div className="label">Papan skor</div>
        <h1 className="mt-2 text-[28px]">Masukkan kode lomba</h1>
        <form
          className="mt-5"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            const clean = input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
            if (clean.length === 6) setActiveCode(clean);
          }}
        >
          <input
            className="field field-code"
            value={input}
            onChange={(e) => setInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
            placeholder="K7M2QX"
            maxLength={6}
            autoFocus
          />
          <button type="submit" className="btn btn-primary btn-lg mt-3 w-full">
            Tampilkan
          </button>
        </form>
      </main>
    );
  }

  const snapshot: Snapshot | null = socket.snapshot;
  const teams = [...(snapshot?.teams ?? [])].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const ranking = snapshot?.ranking ?? [];
  const mode = snapshot?.event.displayMode ?? 'top1';
  const candidate = teams.find((team) => team.id === snapshot?.candidateTeamId) ?? null;
  const round = snapshot?.round ?? null;
  const open = snapshot?.attempt?.status === 'open';
  const status = snapshot?.event.status ?? 'open';
  // Lobi (QR + kode) tampil selama pendaftaran terbuka dan tidak ada ronde yang
  // sedang berjalan. Ronde yang dibatalkan/diulang mengembalikan layar ke lobi,
  // supaya peserta terlambat masih bisa memindai QR. Setelah lomba dimulai
  // (status live) layar menetap di klasemen.
  const registrationOpen = status === 'open' || status === 'draft';
  const roundActive = round?.status === 'open' || open;
  const lobby = snapshot !== null && registrationOpen && !roundActive;
  const joinUrl = `${location.origin}/?code=${activeCode ?? ''}`;

  return (
    <main className="flex min-h-dvh flex-col">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-line px-6 py-4">
        <div>
          <div className="label">Cerdas Cermat · papan skor</div>
          <h1 className="mt-1 text-[clamp(24px,3vw,40px)] leading-none">
            {missing ? 'Lomba tidak tersedia' : (snapshot?.event.name ?? 'Memuat lomba…')}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="num chip text-[13px] tracking-[0.2em] text-signal">{activeCode}</span>
          <Chip tone={lobby ? 'gold' : round?.status === 'open' ? 'signal' : 'default'}>
            {lobby ? 'pendaftaran dibuka' : round ? `ronde ${round.seq} · ${statusLabel(round.status)}` : 'belum ada ronde'}
          </Chip>
          {status === 'finished' ? <Chip tone="gold">lomba selesai</Chip> : null}
          <Chip tone={missing ? 'danger' : socket.status === 'open' ? 'ok' : 'danger'}>
            {missing ? 'kode tidak dikenal' : socket.status === 'open' ? 'terhubung' : 'terputus'}
          </Chip>
          <button
            type="button"
            className="link text-[12px]"
            onClick={() => {
              setActiveCode(null);
              saveScreenCode('');
            }}
          >
            ganti kode
          </button>
        </div>
      </header>

      {lobby ? (
        <div className="grid flex-1 grid-cols-1 gap-6 p-6 xl:grid-cols-[1fr_auto]">
          <section className="min-w-0">
            <div className="flex items-baseline justify-between border-b border-line pb-2">
              <h2 className="label">peserta terdaftar</h2>
              <span className="label normal-case tracking-normal">{teams.length} tim</span>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
              {teams.map((team) => (
                <div key={team.id} className="rise border border-line bg-panel px-3 py-2">
                  <div className="truncate font-display text-[clamp(15px,1.5vw,20px)] leading-tight">{team.name}</div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <StatusDot state={team.online ? 'ok' : 'idle'} />
                    <span className="label normal-case tracking-normal">{team.online ? 'siap' : 'terputus'}</span>
                  </div>
                </div>
              ))}
              {teams.length === 0 ? <p className="col-span-full py-6 text-[14px] text-ink/45">Menunggu peserta pertama…</p> : null}
            </div>
          </section>

          <aside className="w-full max-w-[380px] justify-self-center xl:justify-self-end">
            <div className="border border-line bg-panel p-4 text-center">
              <div className="label">pindai untuk daftar</div>
              <div className="mt-3 inline-block bg-ink p-3">
                <QrCode text={joinUrl} size={200} />
              </div>
              <div className="label mt-4">kode lomba</div>
              <div className="num mt-1 text-[clamp(28px,4vw,44px)] leading-none tracking-[0.24em] text-signal">{activeCode}</div>
              <div className="mt-3 break-all font-mono text-[11px] text-ink/50">{joinUrl}</div>
            </div>
            <p className="mt-3 text-[12px] text-ink/50">Pendaftaran ditutup operator saat lomba dimulai.</p>
          </aside>
        </div>
      ) : null}

      {!lobby && open ? (
        <div className="flex items-center justify-between gap-4 border-b border-signal/40 bg-signal/10 px-6 py-3">
          <span className="font-display text-[clamp(18px,2.4vw,30px)] font-bold tracking-tight text-signal">REBUTAN DIBUKA</span>
          <span className="label text-signal/80">tombol peserta menyala</span>
        </div>
      ) : null}

      {round?.status === 'settled' && !lobby ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gold/40 bg-gold/10 px-6 py-3">
          <span className="font-display text-[clamp(18px,2.4vw,30px)] font-bold tracking-tight text-gold">
            {teams.find((team) => team.id === round.awardedTeamId)?.name ?? '—'} mendapat +{round.points}
          </span>
          <span className="label text-gold/80">ronde {round.seq} selesai</span>
        </div>
      ) : null}

      {missing ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-[460px] border border-line bg-panel p-5">
            <div className="label">papan skor</div>
            <h2 className="mt-2 text-[22px] leading-tight">Kode {activeCode} tidak ditemukan</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-ink/60">
              Lomba ini mungkin sudah dihapus operator. Masukkan kode lomba yang masih berlaku.
            </p>
            <form
              className="mt-4"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                const clean = input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
                if (clean.length === 6) {
                  setInput('');
                  setActiveCode(clean);
                }
              }}
            >
              <input
                className="field field-code"
                aria-label="Kode lomba baru"
                value={input}
                onChange={(e) => setInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
                placeholder="K7M2QX"
                maxLength={6}
              />
              <div className="mt-3 flex gap-2">
                <button type="submit" className="btn btn-primary flex-1" disabled={input.length !== 6}>
                  Tampilkan
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setActiveCode(null);
                    saveScreenCode('');
                  }}
                >
                  Kosongkan
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : !snapshot ? (
        <PageLoader title="Menyiapkan papan skor" hint="Menghubungkan ke lomba…" />
      ) : lobby ? null : (
        <div className="grid flex-1 grid-cols-1 gap-6 p-6 xl:grid-cols-[1.6fr_1fr]">
        <section>
          <div className="flex items-baseline justify-between border-b border-line pb-2">
            <h2 className="label">Klasemen</h2>
            <span className="label normal-case tracking-normal">{teams.length} tim</span>
          </div>
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-line text-ink/40">
                <th className="label py-2 font-normal">#</th>
                <th className="label py-2 font-normal">tim</th>
                <th className="label py-2 text-right font-normal">skor</th>
              </tr>
            </thead>
            <tbody>
              {teams.map((team, index) => {
                const isCandidate = team.id === snapshot?.candidateTeamId;
                return (
                  <tr key={team.id} className={`row ${isCandidate ? 'bg-gold/[0.08]' : ''}`}>
                    <td className={`num py-3 text-[clamp(14px,1.3vw,18px)] ${index === 0 ? 'text-gold' : 'text-ink/40'}`}>{index + 1}</td>
                    <td className="py-3">
                      <span className="flex items-center gap-2">
                        <span className="font-display text-[clamp(18px,2.1vw,28px)] leading-tight">{team.name}</span>
                        {isCandidate ? <Chip tone="gold">menjawab</Chip> : null}
                        <StatusDot state={team.online ? 'ok' : 'idle'} />
                      </span>
                    </td>
                    <td className={`num py-3 text-right text-[clamp(22px,2.6vw,36px)] leading-none ${index === 0 ? 'text-gold' : ''}`}>{team.score}</td>
                  </tr>
                );
              })}
              {teams.length === 0 ? (
                <tr>
                  <td colSpan={3} className="py-6 text-ink/40">
                    Belum ada tim terdaftar.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>

        <aside className="space-y-5">
          <div className="border border-line bg-panel">
            <div className="panel-head">
              <span className="label">kandidat aktif</span>
              <span className="label normal-case tracking-normal">{round ? `ronde ${round.seq}` : '—'}</span>
            </div>
            <div className="px-4 py-5">
              <div className="font-display text-[clamp(24px,3vw,40px)] leading-tight text-gold">{candidate?.name ?? '—'}</div>
              <div className="label mt-2">{candidate ? 'sedang menjawab' : 'belum ditentukan'}</div>
            </div>
          </div>

          <div className="border border-line bg-panel">
            <div className="panel-head">
              <span className="label">urutan tekan</span>
              <span className="label normal-case tracking-normal">{mode === 'all' ? 'semua' : 'hanya tercepat'}</span>
            </div>
            {ranking.length === 0 ? (
              <p className="px-4 py-4 text-[13px] text-ink/45">Tidak ada tekanan pada ronde ini.</p>
            ) : (
              <ol>
                {(mode === 'all' ? ranking : ranking.slice(0, 1)).map((row) => (
                  <li key={row.teamId} className="row flex items-center justify-between gap-3 px-4 py-3">
                    <span className="flex min-w-0 items-center gap-3">
                      <span className={`num text-[13px] ${row.rank === 1 ? 'text-gold' : 'text-ink/40'}`}>{row.rank}</span>
                      <span className="truncate font-display text-[clamp(16px,1.6vw,22px)]">{row.name}</span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {snapshot?.tie ? <div className="border-t border-gold/40 bg-gold/10 px-4 py-2 text-[12px] text-gold">Seri teknis — operator memutuskan.</div> : null}
          </div>
        </aside>
      </div>
      )}

      <footer className="flex items-center justify-end border-t border-line px-6 py-2 text-[11px] text-ink/40">
        <a className="link" href="/keadilan">
          cara penilaian
        </a>
      </footer>
    </main>
  );
}
