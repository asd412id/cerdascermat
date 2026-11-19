import { describe, expect, it } from 'vitest';
import {
  LATE_DELIVERY_GRACE_MS,
  MAX_FLOOR_ALLOWANCE_MS,
  normalizePress,
  pressNeedsReview,
  pressWindow,
  rankPresses,
  requiresExplicitChoice,
  tieRequiresChoice,
  type PressInput,
} from '../shared/rank';

/** Klaim wajar: latensi satu arah `up` sebanding dengan `u` (u = RTT/2). */
function press(teamId: string, d: number, opts: Partial<PressInput> = {}): PressInput {
  return { teamId, d, u: 15, recvDelta: d + 15, ...opts };
}

describe('normalizePress', () => {
  it('membiarkan klaim wajar apa adanya', () => {
    const { dNorm, flags } = normalizePress(press('a', 180, { u: 10, recvDelta: 190 }));
    expect(dNorm).toBe(180);
    expect(flags).toEqual([]);
  });

  it('tidak menaikkan klaim yang lebih cepat dari lantai fisika', () => {
    // recv 70 ms setelah open, u 10, slack 30 → lantai 30 ms. Klaim -30 ms
    // tadinya dinaikkan ke 30 ms; sekarang hanya dijepit ke 0 dan ditandai.
    const { dNorm, flags } = normalizePress({ teamId: 'a', d: -30, u: 10, recvDelta: 70 });
    expect(dNorm).toBe(0);
    expect(flags).toContain('impossible_fast');
    expect(flags).toContain('clamped');
  });

  it('u yang digelembungkan tidak lagi menaikkan klaim', () => {
    // Eksploit lama: u raksasa menurunkan lantai, lalu klaim dinaikkan ke lantai
    // itu. Kini klaim tetap dipakai apa adanya, hanya diberi tanda.
    const cheat = normalizePress({ teamId: 'b', d: -1700, u: 2000, recvDelta: 250 });
    expect(cheat.flags).toContain('impossible_fast');
    expect(cheat.dNorm).toBe(0);
  });

  it('klaim yang lebih lambat dari batas atas dijepit ke batas itu', () => {
    const { dNorm, flags } = normalizePress({ teamId: 'a', d: 400, u: 10, recvDelta: 200 });
    expect(flags).toContain('impossible_slow');
    // 200 + 10 + 30 = 240 ms
    expect(dNorm).toBe(240);
  });

  it('offset jam tidak memengaruhi d karena d relatif terhadap openAt', () => {
    // Dua klien dengan offset ±2 s mengirim d yang sama; server hanya memakai d.
    const a = normalizePress(press('a', 150));
    const b = normalizePress(press('b', 150));
    expect(a.dNorm).toBe(b.dNorm);
    expect(a.flags).toEqual([]);
  });

  it('tim berlatensi tinggi tetap memakai klaimnya, bukan lantai fisika', () => {
    const fast = normalizePress(press('fast', 150, { u: 10, recvDelta: 160 }));
    const slow = normalizePress(press('slow', 150, { u: 140, recvDelta: 290 }));
    const beyond = normalizePress(press('beyond', 150, { u: 600, recvDelta: 750 }));
    expect(fast.flags).toEqual([]);
    expect(slow.flags).toEqual([]);
    expect(slow.dNorm).toBe(150);
    // 750 - plafon 150 - slack 30 = 570: di bawah lantai, tetapi klaim tidak
    // dinaikkan ke 570 — peserta lambat tidak dihukum karena jaringannya.
    expect(beyond.dNorm).toBe(150);
    expect(beyond.flags).toContain('impossible_fast');
  });

  it('klaim 200 ms dengan uplink lambat tetap 200 ms', () => {
    // Regresi utama: dulu klaim ini naik ke 420 - 140 - 30 = 250 ms.
    const { dNorm, flags } = normalizePress({ teamId: 'a', d: 200, u: 140, recvDelta: 420 });
    expect(dNorm).toBe(200);
    expect(flags).toContain('impossible_fast');
    expect(MAX_FLOOR_ALLOWANCE_MS).toBe(150);
  });
});

describe('pressNeedsReview', () => {
  it('tekan bersih tidak perlu diperiksa', () => {
    expect(pressNeedsReview([])).toBe(false);
  });

  it('flag apa pun menandai tekan untuk diperiksa operator', () => {
    expect(pressNeedsReview(['late'])).toBe(true);
    expect(pressNeedsReview(['impossible_fast'])).toBe(true);
    expect(pressNeedsReview(['impossible_slow', 'clamped'])).toBe(true);
  });
});

describe('pressWindow', () => {
  const base = { now: 1_000, openAt: 900, closeAt: 1_200, awarded: false };

  it('menerima tekan di dalam jendela', () => {
    expect(pressWindow(base)).toEqual({ accept: true, late: false, reason: null });
  });

  it('menolak tekan sebelum tombol terbuka', () => {
    expect(pressWindow({ ...base, now: 800 })).toEqual({ accept: false, late: false, reason: 'early' });
  });

  it('menerima kiriman tertunda sampai masa tenggang', () => {
    const late = pressWindow({ ...base, now: base.closeAt + LATE_DELIVERY_GRACE_MS });
    expect(late.accept).toBe(true);
    expect(late.late).toBe(true);
  });

  it('menolak kiriman yang lewat masa tenggang', () => {
    const expired = pressWindow({ ...base, now: base.closeAt + LATE_DELIVERY_GRACE_MS + 1 });
    expect(expired).toEqual({ accept: false, late: true, reason: 'closed' });
  });

  it('masa tenggang bisa diatur dan nol berarti sama dengan close_at', () => {
    expect(pressWindow({ ...base, now: 1_201, graceMs: 0 }).accept).toBe(false);
    expect(pressWindow({ ...base, now: 1_201, graceMs: 500 }).accept).toBe(true);
  });

  it('ronde yang sudah dinilai tidak menerima tekan walau masih di jendela', () => {
    expect(pressWindow({ ...base, awarded: true })).toEqual({ accept: false, late: false, reason: 'awarded' });
  });

  it('tanpa close_at (ronde belum ditutup) tekan diterima', () => {
    expect(pressWindow({ ...base, closeAt: null, now: 10_000 })).toEqual({ accept: true, late: false, reason: null });
  });
});

describe('rankPresses', () => {
  it('mengurutkan berdasarkan d, bukan waktu terima paket', () => {
    const result = rankPresses([
      // B tiba di server lebih dulu (260 ms) tetapi reaksinya 240 ms;
      // A punya latensi satu arah 140 ms sehingga paketnya tiba 330 ms, namun
      // reaksinya 190 ms — masih di dalam jendela fisika miliknya.
      press('b', 240, { recvDelta: 260, u: 15 }),
      press('a', 190, { u: 140, recvDelta: 330 }),
    ]);
    expect(result.ranking.map((r) => r.teamId)).toEqual(['a', 'b']);
    expect(result.winnerTeamId).toBe('a');
  });

  it('dua tekan berjarak 5 ms dianggap seri teknis', () => {
    const result = rankPresses([press('a', 200), press('b', 205)], 15);
    expect(result.tie).toBe(true);
    expect(result.tiedTeamIds).toEqual(['b']);
    expect(result.winnerTeamId).toBe('a');
  });

  it('selisih 60 ms bukan seri', () => {
    const result = rankPresses([press('a', 200), press('b', 260)], 15);
    expect(result.tie).toBe(false);
    expect(result.winnerTeamId).toBe('a');
  });

  it('margin seri memakai ketidakpastian kedua pihak', () => {
    const result = rankPresses([press('a', 200, { u: 100 }), press('b', 290, { u: 100 })], 15);
    // margin = 15 + 100 + 100 = 215 ms
    expect(result.tie).toBe(true);
  });

  it('tekan identik diurutkan stabil dan tetap memberi pemenang tunggal', () => {
    const result = rankPresses([press('b', 200), press('a', 200)], 0);
    expect(result.ranking.map((r) => r.teamId)).toEqual(['a', 'b']);
    expect(result.tie).toBe(true);
  });

  it('daftar kosong tidak meledak', () => {
    const result = rankPresses([], 15);
    expect(result.ranking).toEqual([]);
    expect(result.winnerTeamId).toBeNull();
    expect(result.tie).toBe(false);
  });

  it('gapMs dihitung terhadap pemenang', () => {
    const result = rankPresses([press('a', 200), press('b', 275)], 0);
    expect(result.ranking[0].gapMs).toBe(0);
    expect(result.ranking[1].gapMs).toBe(75);
  });

  it('needsReview diteruskan per baris', () => {
    const result = rankPresses([press('a', 200), { teamId: 'b', d: -40, u: 0, recvDelta: 120 }], 0);
    const byTeam = new Map(result.ranking.map((row) => [row.teamId, row]));
    expect(byTeam.get('a')?.needsReview).toBe(false);
    expect(byTeam.get('b')?.needsReview).toBe(true);
  });
});

describe('requiresExplicitChoice', () => {
  it('butuh teamId dan explicit true', () => {
    expect(requiresExplicitChoice({})).toBe(true);
    expect(requiresExplicitChoice({ teamId: 't1' })).toBe(true);
    expect(requiresExplicitChoice({ teamId: 't1', explicit: false })).toBe(true);
    expect(requiresExplicitChoice({ teamId: '', explicit: true })).toBe(true);
    expect(requiresExplicitChoice({ teamId: 't1', explicit: true })).toBe(false);
  });
});

describe('tieRequiresChoice', () => {
  it('seri tanpa pilihan eksplisit ditolak', () => {
    expect(tieRequiresChoice(true, {})).toBe(true);
    expect(tieRequiresChoice(true, { teamId: 't1' })).toBe(true);
    expect(tieRequiresChoice(true, { teamId: 't1', explicit: false })).toBe(true);
    expect(tieRequiresChoice(true, { teamId: '', explicit: true })).toBe(true);
  });

  it('pilihan eksplisit diterima, dan bukan seri tidak butuh pilihan', () => {
    expect(tieRequiresChoice(true, { teamId: 't1', explicit: true })).toBe(false);
    expect(tieRequiresChoice(false, {})).toBe(false);
  });
});
