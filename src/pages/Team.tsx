import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServerMessage } from '@shared/protocol';
import { clearTeamSession, loadTeamSession } from '../lib/storage';
import { ApiError, api } from '../lib/api';
import { useEventSocket } from '../hooks/useEventSocket';
import { AppFooter, Chip, ConfirmDialog, LinkButton, PageLoader, navigate } from '../components/ui';
import { requestScreenWakeLock, vibrate, wakeLockSupported } from '../lib/device';
import { clearPressTicket, loadPressTicket, pressTicketRemainingMs, savePressTicket, type PressTicket } from '../lib/pressQueue';

type Phase = 'idle' | 'arming' | 'live' | 'sent' | 'done';

interface ArmedAttempt {
  id: string;
  nonce: string;
  /** waktu buka versi jam server (epoch ms) — dikonversi ke lokal saat dipakai */
  openAt: number;
}

export function Team() {
  const [session] = useState(() => loadTeamSession());
  const [phase, setPhase] = useState<Phase>('idle');
  const [confirmExit, setConfirmExit] = useState(false);
  const [openAt, setOpenAt] = useState<number | null>(null);
  const [notice, setNotice] = useState('Menunggu operator membuka rebutan.');
  const [headline, setHeadline] = useState('');
  const [resultTone, setResultTone] = useState<'default' | 'gold' | 'danger'>('default');
  const [delta, setDelta] = useState<number | null>(null);
  const attemptRef = useRef<ArmedAttempt | null>(null);
  const pressedRef = useRef(false);
  const offsetRef = useRef(0);
  const syncedRef = useRef(false);
  const uRef = useRef(0);
  const ticketRef = useRef<PressTicket | null>(null);
  const [queued, setQueued] = useState(false);
  const wakeRef = useRef<{ release: () => Promise<void>; released: boolean } | null>(null);

  useEffect(() => {
    if (!session) navigate('/');
  }, [session]);

  const clearPending = useCallback(() => {
    const ticket = ticketRef.current;
    ticketRef.current = null;
    clearPressTicket(ticket?.attemptId);
    setQueued(false);
  }, []);

  const arm = useCallback((attempt: { id: string; nonce: string; openAt: number }) => {
    // Tiket ronde sebelumnya tidak boleh ikut terkirim ke ronde baru.
    const pending = ticketRef.current;
    if (pending && pending.attemptId !== attempt.id) {
      ticketRef.current = null;
      clearPressTicket(pending.attemptId);
      setQueued(false);
    }
    attemptRef.current = { id: attempt.id, nonce: attempt.nonce, openAt: attempt.openAt };
    pressedRef.current = false;
    setDelta(null);
    setOpenAt(attempt.openAt);
    const armed = attempt.openAt - offsetRef.current > performance.now();
    setPhase(armed ? 'arming' : 'live');
    setNotice(armed ? 'Siap-siap. Tombol terbuka otomatis.' : 'Tombol terbuka. Tekan sekarang.');
    setHeadline('');
    setResultTone('default');
  }, []);

  const onMessage = useCallback(
    (message: ServerMessage) => {
      if (message.type === 'attempt.opened') {
        arm({ id: message.attemptId, nonce: message.nonce, openAt: message.openAt });
        return;
      }
      if (message.type === 'press.ack') {
        clearPending();
        if (message.status === 'received') {
          setPhase('sent');
          setNotice('Tekanan diterima. Menunggu hasil…');
        } else if (message.status === 'dup') {
          setNotice('Tekanan ini sudah tercatat. Satu tekan per tim.');
        } else {
          pressedRef.current = false;
          setPhase('live');
          setNotice('Tekanan belum diterima server. Tekan lagi bila tombol masih terbuka.');
        }
        return;
      }
      if (message.type === 'press.rejected') {
        clearPending();
        if (message.status === 'early') {
          pressedRef.current = false;
          setPhase('live');
          setNotice('Belum terbuka. Tekan setelah tombol hijau.');
        } else if (message.status === 'closed') {
          setPhase('idle');
          setAttemptless('Ronde ini sudah ditutup.');
        } else {
          setNotice(message.message);
        }
        vibrate(30);
        return;
      }
      if (message.type === 'attempt.ranked') {
        clearPending();
        const me = session ? message.ranking.find((r) => r.teamId === session.teamId) : undefined;
        const winner = message.ranking[0];
        setPhase('done');
        setOpenAt(null);
        if (me) {
          setDelta(me.gapMs);
          if (me.rank === 1 && !message.tie) {
            setResultTone('gold');
            setHeadline('TERCEPAT');
            setNotice('Tekanmu tercepat.');
            vibrate([20, 40, 20]);
          } else {
            setResultTone(message.tie && me.rank <= 2 ? 'default' : 'default');
            setHeadline(`#${me.rank}`);
            setNotice(
              winner
                ? message.tie
                  ? `Seri dengan ${winner.name}. Operator memutuskan.`
                  : `${winner.name} lebih cepat ${Math.round(me.gapMs)} ms.`
                : 'Tekanan tercatat.',
            );
          }
        } else {
          setHeadline('TIDAK MENEKAN');
          setNotice(winner ? `${winner.name} menekan lebih dulu.` : 'Tidak ada tekanan pada ronde ini.');
        }
        return;
      }
      if (message.type === 'round.settled') {
        clearPending();
        const awarded = message.round?.awardedTeamId;
        const mine = session && awarded === session.teamId;
        setPhase('done');
        setOpenAt(null);
        setResultTone(mine ? 'gold' : 'default');
        setHeadline(mine ? `+${message.round?.points ?? 0}` : 'RONDE SELESAI');
        setNotice(mine ? 'Poin untuk tim ini.' : 'Poin diberikan ke tim lain. Siap untuk ronde berikutnya.');
        if (mine) vibrate([16, 40, 16]);
        return;
      }
      if (message.type === 'round.void') {
        clearPending();
        setPhase('idle');
        setOpenAt(null);
        setHeadline('');
        setAttemptless('Ronde dibatalkan operator.');
        setResultTone('danger');
        return;
      }
      if (message.type === 'hello.err') {
        setNotice(message.code === 'kicked' ? 'Dikeluarkan operator.' : message.message);
        if (message.code === 'bad_token' || message.code === 'no_team' || message.code === 'kicked' || message.code === 'deleted') {
          clearTeamSession();
          setTimeout(() => navigate('/'), message.code === 'deleted' ? 1200 : 1500);
        }
      }
    },
    [arm, clearPending, session],
  );

  function setAttemptless(text: string) {
    attemptRef.current = null;
    setNotice(text);
    setHeadline('');
    setResultTone('default');
  }

  const socket = useEventSocket({
    code: session?.eventCode,
    role: 'team',
    token: session?.token,
    teamId: session?.teamId,
    enabled: Boolean(session),
    onMessage,
  });

  offsetRef.current = socket.clock.offset;
  syncedRef.current = socket.clock.synced;
  uRef.current = Number.isFinite(socket.clock.u) ? socket.clock.u : 0;
  const sendRef = useRef(socket.send);
  sendRef.current = socket.send;

  /**
   * Kirim ulang tiket yang tersimpan. `send` mengembalikan false saat socket
   * tertutup, jadi tiket tetap di perangkat sampai server benar-benar menjawab.
   */
  const flush = useCallback(() => {
    const ticket = ticketRef.current;
    if (!ticket) return;
    if (pressTicketRemainingMs(ticket) <= 0) {
      ticketRef.current = null;
      clearPressTicket(ticket.attemptId);
      pressedRef.current = false;
      setQueued(false);
      setPhase((current) => (current === 'sent' ? 'live' : current));
      setNotice('Kiriman kedaluwarsa. Tekan ulang bila tombol masih terbuka.');
      return;
    }
    const sent = sendRef.current({ type: 'press', attemptId: ticket.attemptId, nonce: ticket.nonce, d: ticket.d, u: ticket.u });
    setNotice(sent ? 'Terkirim. Menunggu jawaban server…' : 'Belum tersambung. Tekanan disimpan dan dikirim otomatis.');
  }, []);

  // Server tidak pernah mengirim snapshot bila kode lomba salah atau lombanya sudah
  // dihapus. Setelah beberapa detik beri jalan keluar, jangan biarkan loader abadi.
  const [slowConnect, setSlowConnect] = useState(false);
  useEffect(() => {
    if (!session || socket.snapshot) {
      setSlowConnect(false);
      return;
    }
    const timer = setTimeout(() => setSlowConnect(true), 7000);
    return () => clearTimeout(timer);
  }, [session, socket.snapshot, socket.status]);

  useEffect(() => {
    if (openAt === null) return;
    let raf = 0;
    const tick = () => {
      // offset jam bisa baru tersedia setelah attempt dibuka, jadi hitung ulang tiap frame
      const ms = openAt - offsetRef.current - performance.now();
      if (ms > 0) {
        raf = requestAnimationFrame(tick);
      } else {
        setPhase((current) => (current === 'arming' ? 'live' : current));
        setNotice((current) => (current.startsWith('Siap-siap') ? 'Tombol terbuka. Tekan sekarang.' : current));
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [openAt]);

  // Setelah reconnect, snapshot membawa attempt yang masih terbuka.
  useEffect(() => {
    const attempt = socket.snapshot?.attempt;
    if (!attempt) return;
    if (attempt.status === 'open' && attemptRef.current?.id !== attempt.id) {
      arm({ id: attempt.id, nonce: attempt.nonce, openAt: attempt.openAt });
    }
    if (attempt.status !== 'open' && socket.snapshot?.ranking.length && phase === 'idle') {
      setPhase('done');
    }
  }, [socket.snapshot, arm, phase]);

  // Lomba bisa dihapus saat perangkat sedang terputus; percobaan menyambung
  // ulang akan ditolak karena kodenya tidak lagi dikenal. Cek lewat HTTP supaya
  // peserta tidak menggantung di layar rebutan, lalu keluar ke halaman daftar.
  useEffect(() => {
    if (!session || socket.status !== 'closed' || !socket.snapshot) return;
    const timer = setInterval(() => {
      api(`/api/public/events/${session.eventCode}`).catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) {
          clearTeamSession();
          navigate('/');
        }
      });
    }, 5000);
    return () => clearInterval(timer);
  }, [session, socket.status, socket.snapshot]);

  const press = useCallback(() => {
    const attempt = attemptRef.current;
    if (!attempt) {
      setNotice('Belum ada ronde. Menunggu operator membuka tombol.');
      return;
    }
    if (pressedRef.current || ticketRef.current) return;
    if (!syncedRef.current) {
      setNotice('Perangkat belum siap. Coba lagi sebentar.');
      return;
    }
    const p = performance.now();
    const d = p - (attempt.openAt - offsetRef.current);
    if (d < 0) {
      vibrate(10);
      setNotice('Belum terbuka. Tekan setelah tombol hijau.');
      return;
    }
    pressedRef.current = true;
    const ticket: PressTicket = { attemptId: attempt.id, nonce: attempt.nonce, d, u: uRef.current, createdAt: Date.now() };
    // Catat dulu, kirim kemudian: jaringan putus tidak boleh menghapus tekan.
    ticketRef.current = ticket;
    savePressTicket(ticket);
    vibrate(18);
    setPhase('sent');
    setNotice('Mengirim…');
    setQueued(true);
  }, []);

  // Kirim ulang tiap 700 ms sampai server menjawab. Tombol tidak menunggu
  // socket terbuka, karena tekanannya sudah tersimpan di perangkat.
  useEffect(() => {
    if (!queued) return;
    flush();
    const timer = setInterval(flush, 700);
    return () => clearInterval(timer);
  }, [queued, flush]);

  // Socket baru tersambung: jangan menunggu satu interval lagi.
  useEffect(() => {
    if (socket.status === 'open' && ticketRef.current) flush();
  }, [socket.status, flush]);

  // Tiket dari halaman sebelumnya (reload saat jaringan putus) dilanjutkan.
  useEffect(() => {
    const ticket = loadPressTicket();
    if (!ticket || pressedRef.current) return;
    ticketRef.current = ticket;
    pressedRef.current = true;
    setPhase('sent');
    setQueued(true);
    setNotice('Mengirim ulang tekanan yang tersimpan…');
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.key !== ' ' && event.key !== 'Enter') return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      event.preventDefault();
      press();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press]);

  // wake lock: minta saat interaksi pertama, dan ulangi setelah tab kembali terlihat
  useEffect(() => {
    const ensure = async () => {
      if (!wakeLockSupported()) return;
      if (wakeRef.current && !wakeRef.current.released) return;
      wakeRef.current = await requestScreenWakeLock();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void ensure();
    };
    const once = () => void ensure();
    window.addEventListener('pointerdown', once, { once: true });
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      void wakeRef.current?.release().catch(() => undefined);
    };
  }, []);

  if (!session) return <PageLoader title="Mengalihkan" hint="Membuka halaman pendaftaran…" />;
  if (!socket.snapshot) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-5 px-5">
        <PageLoader
          compact
          title="Menyambung ke lomba"
          hint={
            slowConnect
              ? 'Server belum menjawab. Lomba mungkin sudah dihapus operator.'
              : 'Mengambil status ronde, skor, dan peringkat.'
          }
        />
        {slowConnect ? (
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setSlowConnect(false);
                socket.reconnect();
              }}
            >
              Sambung ulang
            </button>
            <LinkButton href="/">Halaman daftar</LinkButton>
          </div>
        ) : null}
      </main>
    );
  }

  const team = socket.snapshot?.teams.find((t) => t.id === session.teamId);
  const round = socket.snapshot?.round;
  const attempt = socket.snapshot?.attempt;
  const myRank = socket.snapshot?.ranking.find((r) => r.teamId === session.teamId);
  const isCandidate = socket.snapshot?.candidateTeamId === session.teamId;
  const mode = socket.snapshot?.event.displayMode ?? 'top1';

  const lobby = socket.snapshot?.event.status === 'open' || socket.snapshot?.event.status === 'draft';

  const palette =
    phase === 'live'
      ? 'bg-signal text-[#16130f] border-signal'
      : phase === 'arming'
        ? 'bg-panel text-gold border-gold'
        : phase === 'done' && resultTone === 'gold'
          ? 'bg-gold text-[#1a1714] border-gold'
          : phase === 'sent'
            ? 'bg-panel2 text-ink/80 border-line'
            : 'bg-panel text-ink/55 border-line';

  return (
    <main className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <div className="min-w-0">
          <div className="label truncate">
            {session.eventName} · ronde {round?.seq ?? '—'}
          </div>
          <div className="mt-0.5 truncate font-display text-[18px] leading-tight">{session.teamName}</div>
        </div>
        <div className="text-right">
          <div className="label">skor</div>
          <div className="num text-[22px] leading-none">{team?.score ?? 0}</div>
        </div>
      </header>

      {isCandidate ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-1.5">
          <Chip tone="gold">giliran anda</Chip>
        </div>
      ) : null}

      {lobby ? (
        <div className="border-b border-line bg-panel px-4 py-2 text-[12px] text-ink/60">
          Terdaftar sebagai <span className="text-ink">{session.teamName}</span>. Menunggu operator memulai lomba.
        </div>
      ) : null}

      {socket.snapshot?.event.status === 'finished' ? (
        <div className="border-b border-line bg-panel px-4 py-2 text-[12px] text-ink/60">
          Lomba sudah selesai. Terima kasih sudah bertanding.
        </div>
      ) : null}

      {socket.status === 'closed' ? (
        <div className="flex items-center justify-between gap-3 border-b border-danger/40 bg-danger/10 px-4 py-2 text-[12px] text-danger">
          <span>Sambungan terputus. Tekanan disimpan di perangkat dan dikirim otomatis.</span>
          <button type="button" className="btn btn-danger h-7 min-h-0 px-2 py-0 text-[11px]" onClick={socket.reconnect}>
            Sambung ulang
          </button>
        </div>
      ) : null}

      <div className="flex flex-1 flex-col gap-3 p-3">
        <button
          type="button"
          data-testid="buzzer"
          data-phase={phase}
          aria-disabled={phase !== 'live'}
          onPointerDown={(event) => {
            event.preventDefault();
            press();
          }}
          onContextMenu={(event) => event.preventDefault()}
          className={`relative flex min-h-[44vh] flex-1 touch-manipulation select-none items-center justify-center border px-5 py-8 text-center transition-colors duration-150 ${palette}`}
          style={{ WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}
        >
          <div className="w-full">
            <div className="label" style={{ color: 'currentColor', opacity: phase === 'live' ? 0.7 : 0.55 }}>
              {phase === 'live'
                ? 'tombol terbuka'
                : phase === 'arming'
                  ? 'bersiap'
                  : phase === 'sent'
                    ? 'terkirim'
                    : phase === 'done'
                      ? 'hasil'
                      : 'menunggu operator'}
            </div>
            <div className="mt-3 font-display text-[clamp(46px,13vw,84px)] leading-[0.95] font-extrabold tracking-[-0.04em]">
              {phase === 'live'
                ? 'TEKAN'
                : phase === 'arming'
                  ? 'SIAP-SIAP'
                  : phase === 'sent'
                    ? 'TERKIRIM'
                    : phase === 'done'
                      ? headline || 'SELESAI'
                      : 'MENUNGGU'}
            </div>
            {phase === 'arming' ? (
              <div className="mt-3 text-[15px] leading-snug opacity-70">Tombol terbuka sendiri sebentar lagi.</div>
            ) : null}
            {phase === 'done' && delta !== null ? (
              <div className="num mt-3 text-[14px] opacity-75">selisih {Math.round(delta)} ms</div>
            ) : null}
          </div>
        </button>

        <p className="min-h-[2.5rem] text-center text-[13px] text-ink/70" role="status">
          {notice}
        </p>

        <div className="grid grid-cols-2 divide-x divide-line border border-line">
          <div className="px-3 py-2">
            <div className="label">ronde</div>
            <div className="num mt-1 text-[15px]">{round?.seq ?? '—'}</div>
          </div>
          <div className="px-3 py-2">
            <div className="label">peringkat</div>
            <div className="num mt-1 text-[15px]">{myRank ? `#${myRank.rank}` : '—'}</div>
          </div>
        </div>

        {attempt && (attempt.status === 'closed' || attempt.status === 'settled') && socket.snapshot?.ranking.length ? (
          <div className="border border-line bg-panel">
            <div className="panel-head">
              <span className="label">urutan tekan</span>
              <span className="label normal-case tracking-normal">
                {socket.snapshot.tie ? 'seri' : mode === 'all' ? `semua · ${socket.snapshot.ranking.length} tim` : 'hanya tercepat'}
              </span>
            </div>
            <ol>
              {(mode === 'all' ? socket.snapshot.ranking.slice(0, 6) : socket.snapshot.ranking.slice(0, 1)).map((row) => (
                <li key={row.teamId} className={`row flex items-center justify-between gap-3 px-3 py-2 ${row.teamId === session.teamId ? 'bg-white/[0.03]' : ''}`}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={`num text-[12px] ${row.rank === 1 ? 'text-gold' : 'text-ink/45'}`}>{row.rank}</span>
                    <span className="truncate text-[13px]">{row.name}</span>
                  </span>
                  <span className="num shrink-0 text-[12px] text-ink/60">{row.rank === 1 ? '0 ms' : `+${Math.round(row.gapMs)} ms`}</span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2">
        <button type="button" className="link text-[11px]" onClick={() => setConfirmExit(true)}>
          Keluar tim
        </button>
        <LinkButton href="/keadilan">cara penilaian</LinkButton>
      </div>

      <AppFooter />

      {confirmExit && session ? (
        <ConfirmDialog
          title="Keluar dari tim?"
          message={
            <>
              Perangkat ini berhenti sebagai <strong className="text-ink">{session.teamName}</strong>. Tim tetap terdaftar di
              lomba; untuk masuk lagi cukup buka halaman daftar di perangkat ini dan pilih masuk kembali.
            </>
          }
          confirmLabel="Ya, keluar"
          onCancel={() => setConfirmExit(false)}
          onConfirm={() => {
            clearTeamSession();
            navigate('/');
          }}
        />
      ) : null}
    </main>
  );
}
