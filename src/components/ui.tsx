import { useState, type ReactNode } from 'react';

export function navigate(to: string): void {
  if (location.pathname === to) return;
  history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function Panel({
  title,
  aside,
  children,
  className = '',
  bodyClassName = '',
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {title ? (
        <header className="panel-head min-w-0">
          <h2 className="label min-w-0 truncate text-ink/80">{title}</h2>
          {aside ? <div className="label shrink-0 normal-case tracking-normal text-ink/60">{aside}</div> : null}
        </header>
      ) : null}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export function Metric({ label, value, tone = 'default' }: { label: string; value: ReactNode; tone?: 'default' | 'signal' | 'gold' | 'danger' | 'ok' }) {
  const color =
    tone === 'signal' ? 'text-signal' : tone === 'gold' ? 'text-gold' : tone === 'danger' ? 'text-danger' : tone === 'ok' ? 'text-ok' : 'text-ink';
  return (
    <div className="px-3 py-3">
      <div className="label">{label}</div>
      <div className={`mt-1.5 font-mono text-[19px] leading-none tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'draf',
  idle: 'menunggu',
  open: 'terbuka',
  live: 'berjalan',
  closed: 'ditutup',
  finished: 'selesai',
  settled: 'selesai',
  void: 'dibatalkan',
};

/** label bahasa Indonesia untuk status event/ronde/attempt dari server */
export function statusLabel(status: string | null | undefined): string {
  return status ? (STATUS_LABEL[status] ?? status) : '—';
}

export function Chip({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'signal' | 'gold' | 'danger' | 'ok' }) {
  const color =
    tone === 'signal'
      ? 'text-signal border-signal/50'
      : tone === 'gold'
        ? 'text-gold border-gold/50'
        : tone === 'danger'
          ? 'text-danger border-danger/50'
          : tone === 'ok'
            ? 'text-ok border-ok/40'
            : 'text-ink/70';
  return <span className={`chip ${color}`}>{children}</span>;
}

export function StatusDot({ state }: { state: 'ok' | 'warn' | 'bad' | 'idle' }) {
  const color = state === 'ok' ? 'bg-ok' : state === 'warn' ? 'bg-gold' : state === 'bad' ? 'bg-danger' : 'bg-ink/30';
  return <span className={`inline-block size-1.5 ${color}`} aria-hidden="true" />;
}

export function AppFooter({ note }: { note?: ReactNode }) {
  return (
    <footer className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-ink/50">
      <span className="label normal-case tracking-normal">{note ?? 'Selamat bertanding.'}</span>
    </footer>
  );
}

export function LinkButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="link text-[12px]"
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

export function ServerDown({ onRetry, checking }: { onRetry: () => void; checking: boolean }) {  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col justify-center px-5 py-10">
      <div className="label">Cerdas Cermat 2026</div>
      <h1 className="mt-3 text-[30px] leading-[1.1]">Lomba belum tersambung</h1>
      <p className="mt-3 text-[14px] text-ink/70">
        Sambungan ke server lomba terputus. Coba lagi sebentar; bila tetap gagal, hubungi operator.
      </p>
      <button type="button" className="btn btn-primary btn-lg mt-5" onClick={onRetry} disabled={checking}>
        {checking ? 'Mencoba…' : 'Coba lagi'}
      </button>
    </main>
  );
}

/** Putaran kecil untuk menandai pekerjaan yang sedang berjalan. */
export function Spinner({ className = 'size-3' }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block animate-spin rounded-full border border-ink/25 border-t-signal ${className}`}
    />
  );
}

/** Baris status pemuatan: dipakai saat data lomba sedang diganti. */
export function LoadingRow({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-ink/60" role="progressbar" aria-busy="true" aria-label={text}>
      <Spinner />
      <span>{text}</span>
    </div>
  );
}

/** Ikon mata: dipakai tombol tampilkan/sembunyikan sandi. */
function EyeIcon({ hidden }: { hidden: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.5" />
      {hidden ? <path d="M4 20 20 4" /> : null}
    </svg>
  );
}

/** Ikon bel: dipakai tombol suara bel dan spanduk tekan di papan skor. */
export function BellIcon({ muted = false, className = 'h-3.5 w-3.5' }: { muted?: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 16V11a6 6 0 0 1 12 0v5l1.6 2.6H4.4L6 16Z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
      {muted ? <path d="M4 20 20 4" /> : null}
    </svg>
  );
}

/**
 * Kolom sandi dengan tombol ikon mata. Label tetap terpisah dari tombol agar
 * nama aksesibel kolom tidak tercampur teks tombol.
 */
export function PasswordField({
  id,
  label,
  value,
  onChange,
  placeholder,
  autoComplete,
  required,
  className = 'h-10',
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete?: string;
  required?: boolean;
  className?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <div className="relative mt-1">
        <input
          id={id}
          className={`field ${className} pr-11`}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          required={required}
        />
        <button
          type="button"
          className="absolute inset-y-0 right-0 flex items-center px-3 text-ink/45 transition-colors hover:text-signal focus-visible:text-signal"
          onClick={() => setVisible((current) => !current)}
          aria-pressed={visible}
          aria-label={visible ? 'Sembunyikan sandi' : 'Tampilkan sandi'}
          title={visible ? 'Sembunyikan sandi' : 'Tampilkan sandi'}
        >
          <EyeIcon hidden={visible} />
        </button>
      </div>
    </div>
  );
}

/**
 * Dialog konfirmasi untuk aksi yang mudah tersentuh tanpa sengaja.
 * `secondaryLabel` dipakai bila ada dua pilihan yang sama-sama masuk akal
 * (misalnya "masuk kembali" atau "daftar tim baru").
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  secondaryLabel,
  confirmTone = 'danger',
  busy = false,
  onCancel,
  onConfirm,
  onSecondary,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  secondaryLabel?: string;
  confirmTone?: 'danger' | 'primary';
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onSecondary?: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 p-4 sm:items-center" role="dialog" aria-modal="true">
      <div className="w-full max-w-[420px] border border-line bg-panel p-4">
        <h2 className="text-[18px]">{title}</h2>
        <div className="mt-2 text-[13px] leading-relaxed text-ink/70">{message}</div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className={`btn flex-1 whitespace-nowrap ${confirmTone === 'danger' ? 'btn-danger' : 'btn-primary'}`}
            onClick={onConfirm}
            disabled={busy}
            autoFocus
          >
            {confirmLabel}
          </button>
          {secondaryLabel && onSecondary ? (
            <button type="button" className="btn flex-1 whitespace-nowrap" onClick={onSecondary} disabled={busy}>
              {secondaryLabel}
            </button>
          ) : null}
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Batal
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Pemuatan satu area penuh. Dipakai saat data lomba belum siap, supaya pengguna
 * melihat proses yang jelas alih-alih layar kosong.
 */
export function PageLoader({ title, hint, compact = false }: { title: string; hint?: string; compact?: boolean }) {
  return (
    <div
      role="progressbar"
      aria-busy="true"
      aria-label={title}
      className={`flex w-full items-center justify-center ${compact ? 'px-4 py-10' : 'min-h-[60vh] flex-1 px-6 py-12'}`}
    >
      <div className="text-center">
        <div className="relative mx-auto size-14">
          <span className="absolute inset-0 rounded-full border border-line" />
          <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-signal [animation-duration:1.2s]" />
          <span className="absolute inset-0 m-auto size-2.5 animate-pulse rounded-full bg-signal" />
        </div>
        <div className="mt-5 flex items-center justify-center gap-1.5" aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              className="size-1 animate-bounce rounded-full bg-ink/45"
              style={{ animationDelay: `${index * 140}ms`, animationDuration: '900ms' }}
            />
          ))}
        </div>
        <div className="mt-3 font-display text-[clamp(15px,1.7vw,20px)] leading-tight">{title}</div>
        {hint ? <p className="mt-1.5 text-[12px] text-ink/50">{hint}</p> : null}
      </div>
    </div>
  );
}
