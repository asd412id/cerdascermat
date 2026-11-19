/**
 * Tiket tekan persisten — satu tekan per tim, disimpan di localStorage supaya
 * kiriman selamat dari putus jaringan, socket mati, bahkan reload halaman.
 *
 * Alur: `Team.tsx` menyimpan tiket saat jari menyentuh tombol, mengirim ulang
 * tiap 700 ms sampai server menjawab (`press.ack` / `press.rejected`), lalu
 * membersihkannya. TTL mencegah tiket lama ikut terkirim ke ronde berikutnya.
 */

export const PRESS_TICKET_TTL_MS = 90_000;
const KEY = 'cc.press.v1';

export interface PressTicket {
  attemptId: string;
  nonce: string;
  d: number;
  u: number;
  createdAt: number;
}

/** Cadangan saat localStorage tidak tersedia (mode privat, uji node). */
const memory = new Map<string, string>();

function readRaw(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return memory.get(KEY) ?? null;
  }
}

function writeRaw(value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, value);
    return;
  } catch {
    // localStorage ditolak; pakai cadangan memori halaman ini
  }
  if (value === null) memory.delete(KEY);
  else memory.set(KEY, value);
}

function isTicket(value: unknown): value is PressTicket {
  if (!value || typeof value !== 'object') return false;
  const ticket = value as Record<string, unknown>;
  return (
    typeof ticket.attemptId === 'string' &&
    ticket.attemptId.length > 0 &&
    typeof ticket.nonce === 'string' &&
    ticket.nonce.length > 0 &&
    typeof ticket.d === 'number' &&
    Number.isFinite(ticket.d) &&
    typeof ticket.u === 'number' &&
    Number.isFinite(ticket.u) &&
    typeof ticket.createdAt === 'number' &&
    Number.isFinite(ticket.createdAt)
  );
}

export function savePressTicket(ticket: PressTicket): void {
  writeRaw(JSON.stringify(ticket));
}

/** `attemptId` opsional: hanya kembalikan tiket milik attempt itu. */
export function loadPressTicket(attemptId?: string, now = Date.now()): PressTicket | null {
  const raw = readRaw();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearPressTicket();
    return null;
  }
  if (!isTicket(parsed)) {
    clearPressTicket();
    return null;
  }
  if (now - parsed.createdAt > PRESS_TICKET_TTL_MS) {
    clearPressTicket();
    return null;
  }
  if (attemptId && parsed.attemptId !== attemptId) return null;
  return parsed;
}

/** Tanpa `attemptId`, semua tiket dibuang. */
export function clearPressTicket(attemptId?: string): void {
  if (!attemptId) {
    writeRaw(null);
    return;
  }
  const raw = readRaw();
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as { attemptId?: unknown };
    if (parsed.attemptId === attemptId) writeRaw(null);
  } catch {
    writeRaw(null);
  }
}

export function pressTicketRemainingMs(ticket: PressTicket, now = Date.now()): number {
  return Math.max(0, PRESS_TICKET_TTL_MS - (now - ticket.createdAt));
}
