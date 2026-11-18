import { describe, expect, it } from 'vitest';
import { normalizePress, rankPresses, type PressInput } from '../shared/rank';

function press(teamId: string, d: number, opts: Partial<PressInput> = {}): PressInput {
  return { teamId, d, u: 15, recvDelta: d + 40, rttMinMs: 20, ...opts };
}

describe('normalizePress', () => {
  it('membiarkan klaim wajar apa adanya', () => {
    const { dNorm, flags } = normalizePress(press('a', 180, { recvDelta: 220, rttMinMs: 20, u: 10 }));
    expect(dNorm).toBe(180);
    expect(flags).toEqual([]);
  });

  it('menandai klaim 30 ms di masa lalu sebagai impossible_fast', () => {
    // recv 70 ms setelah open, rttMin 20, u 10, slack 30 → lantai = 10 ms
    const { dNorm, flags } = normalizePress({ teamId: 'a', d: -30, u: 10, recvDelta: 70, rttMinMs: 20 });
    expect(flags).toContain('impossible_fast');
    expect(dNorm).toBe(10);
  });

  it('menandai klaim lebih lambat dari waktu terima sebagai impossible_slow', () => {
    const { dNorm, flags } = normalizePress({ teamId: 'a', d: 400, u: 10, recvDelta: 200, rttMinMs: 20 });
    expect(flags).toContain('impossible_slow');
    expect(dNorm).toBe(240);
  });

  it('offset jam tidak memengaruhi d karena d relatif terhadap openAt', () => {
    // Dua klien dengan offset ±2 s mengirim d yang sama; server hanya memakai d.
    const a = normalizePress(press('a', 150));
    const b = normalizePress(press('b', 150));
    expect(a.dNorm).toBe(b.dNorm);
    expect(a.flags).toEqual([]);
  });

  it('rtt 20 vs 200 ms: keduanya sah, tapi rentang fisika klien lambat lebih lebar', () => {
    const fast = normalizePress({ teamId: 'fast', d: 150, u: 10, recvDelta: 170, rttMinMs: 20 });
    const slow = normalizePress({ teamId: 'slow', d: 150, u: 100, recvDelta: 300, rttMinMs: 200 });
    expect(fast.flags).toEqual([]);
    expect(slow.flags).toEqual([]);
  });
});

describe('rankPresses', () => {
  it('mengurutkan berdasarkan d, bukan waktu terima paket', () => {
    const result = rankPresses([
      // B tiba di server lebih dulu (260 ms) tetapi reaksinya 240 ms;
      // A punya RTT 300 ms sehingga paketnya tiba 500 ms, namun reaksinya 190 ms.
      press('b', 240, { recvDelta: 260, rttMinMs: 20 }),
      press('a', 190, { recvDelta: 500, rttMinMs: 300 }),
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
});
