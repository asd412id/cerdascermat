import { describe, expect, it } from 'vitest';
import {
  EARLY_SLACK_MS,
  MAX_FLOOR_ALLOWANCE_MS,
  normalizePress,
  rankPresses,
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

  it('menandai klaim di masa lalu sebagai impossible_fast', () => {
    // recv 70 ms setelah open, u 10, slack 30 → lantai = 70 - 10 - 30 = 30 ms
    const { dNorm, flags } = normalizePress({ teamId: 'a', d: -30, u: 10, recvDelta: 70 });
    expect(flags).toContain('impossible_fast');
    expect(dNorm).toBe(30);
  });

  it('u yang digelembungkan hanya menggeser lantai sebesar plafon kelonggaran', () => {
    // Eksploit lama: u raksasa menurunkan lantai tanpa batas. Kini lantai dijepit
    // MAX_FLOOR_ALLOWANCE_MS, jadi keuntungan maksimal berbohong = plafon itu.
    const cheat = normalizePress({ teamId: 'b', d: -1700, u: 2000, recvDelta: 250 });
    expect(cheat.flags).toContain('impossible_fast');
    expect(cheat.dNorm).toBe(250 - MAX_FLOOR_ALLOWANCE_MS - EARLY_SLACK_MS);
  });

  it('menandai klaim lebih lambat dari waktu terima sebagai impossible_slow', () => {
    const { dNorm, flags } = normalizePress({ teamId: 'a', d: 400, u: 10, recvDelta: 200 });
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

  it('tim berlatensi tinggi dikoreksi sampai plafon, selebihnya dijepit', () => {
    const fast = normalizePress(press('fast', 150, { u: 10, recvDelta: 160 }));
    const slow = normalizePress(press('slow', 150, { u: 140, recvDelta: 290 }));
    const beyond = normalizePress(press('beyond', 150, { u: 600, recvDelta: 750 }));
    expect(fast.flags).toEqual([]);
    expect(slow.flags).toEqual([]);
    expect(slow.dNorm).toBe(150);
    // 750 - plafon 150 - slack 30 = 570: koreksi berhenti di plafon.
    expect(beyond.dNorm).toBe(750 - MAX_FLOOR_ALLOWANCE_MS - EARLY_SLACK_MS);
    expect(beyond.flags).toContain('impossible_fast');
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
