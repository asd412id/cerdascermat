import { beforeEach, describe, expect, it } from 'vitest';
import {
  PRESS_TICKET_TTL_MS,
  clearPressTicket,
  loadPressTicket,
  pressTicketRemainingMs,
  savePressTicket,
  type PressTicket,
} from '../src/lib/pressQueue';

function ticket(overrides: Partial<PressTicket> = {}): PressTicket {
  return { attemptId: 'att-1', nonce: 'nonce-1', d: 214.5, u: 32, createdAt: 1_000_000, ...overrides };
}

describe('pressQueue', () => {
  beforeEach(() => {
    clearPressTicket();
  });

  it('menyimpan lalu memuat tiket apa adanya', () => {
    const saved = ticket();
    savePressTicket(saved);
    expect(loadPressTicket(undefined, saved.createdAt + 500)).toEqual(saved);
  });

  it('hanya mengembalikan tiket milik attempt yang diminta', () => {
    savePressTicket(ticket());
    expect(loadPressTicket('att-lain', 1_000_500)).toBeNull();
    // tiket tidak ikut terhapus hanya karena ditanya attempt lain
    expect(loadPressTicket('att-1', 1_000_500)).not.toBeNull();
  });

  it('membuang tiket yang kedaluwarsa', () => {
    const saved = ticket();
    savePressTicket(saved);
    const expiredAt = saved.createdAt + PRESS_TICKET_TTL_MS + 1;
    expect(loadPressTicket(undefined, expiredAt)).toBeNull();
    // sudah dibersihkan: permintaan berikutnya juga kosong
    expect(loadPressTicket()).toBeNull();
  });

  it('tiket tepat di batas TTL masih sah', () => {
    const saved = ticket();
    savePressTicket(saved);
    expect(loadPressTicket(undefined, saved.createdAt + PRESS_TICKET_TTL_MS)).not.toBeNull();
  });

  it('menghapus tiket berdasarkan attempt id', () => {
    savePressTicket(ticket());
    clearPressTicket('att-lain');
    expect(loadPressTicket(undefined, 1_000_500)).not.toBeNull();
    clearPressTicket('att-1');
    expect(loadPressTicket(undefined, 1_000_500)).toBeNull();
  });

  it('tiket rusak dianggap tidak ada', () => {
    savePressTicket(ticket({ attemptId: '', nonce: '' }));
    expect(loadPressTicket()).toBeNull();
  });

  it('sisa umur dihitung dari TTL', () => {
    const saved = ticket();
    expect(pressTicketRemainingMs(saved, saved.createdAt)).toBe(PRESS_TICKET_TTL_MS);
    expect(pressTicketRemainingMs(saved, saved.createdAt + 10_000)).toBe(PRESS_TICKET_TTL_MS - 10_000);
    expect(pressTicketRemainingMs(saved, saved.createdAt + PRESS_TICKET_TTL_MS * 2)).toBe(0);
  });
});
