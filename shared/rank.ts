/**
 * ranking tekan — modul murni, dipakai server dan uji.
 *
 * Klien merekam `d` = performance.now() - openAtLocal saat pointerdown.
 * Server tidak membandingkan waktu terima; ia memvalidasi `d` terhadap
 * jendela fisika (perjalanan minimum RTT + ketidakpastian offset + jitter)
 * lalu memberi peringkat berdasarkan `dNorm`.
 */

export const EARLY_SLACK_MS = 30;
export const LATE_SLACK_MS = 30;

export type PressFlag = 'impossible_fast' | 'impossible_slow' | 'clamped';

export interface PressRaw {
  teamId: string;
  /** klaim reaksi klien, ms sejak openAt (bisa negatif) */
  d: number;
  /** ketidakpastian offset klien, ms */
  u: number;
  /** recvServer - openAt, ms — batas atas fisika */
  recvDelta: number;
}

export interface PressInput extends PressRaw {
  /** RTT minimum yang diukur server untuk tim ini, ms */
  rttMinMs: number;
}

export interface RankedPress {
  teamId: string;
  rank: number;
  dRaw: number;
  dNorm: number;
  u: number;
  flags: PressFlag[];
  /** selisih terhadap pemenang, ms */
  gapMs: number;
}

export interface RankResult {
  ranking: RankedPress[];
  /** true bila ada penekan yang selisihnya di dalam margin ketidakpastian */
  tie: boolean;
  tiedTeamIds: string[];
  winnerTeamId: string | null;
  marginMs: number;
}

export function normalizePress(input: PressInput): { dNorm: number; flags: PressFlag[] } {
  const flags: PressFlag[] = [];
  const travelFloor = input.recvDelta - input.rttMinMs - input.u - EARLY_SLACK_MS;
  const travelCeil = input.recvDelta + input.u + LATE_SLACK_MS;

  let d = input.d;
  if (!Number.isFinite(d)) {
    d = input.recvDelta;
    flags.push('clamped');
  }
  if (d < travelFloor) flags.push('impossible_fast');
  if (d > travelCeil) flags.push('impossible_slow');

  const clamped = Math.min(travelCeil, Math.max(travelFloor, d));
  if (clamped !== d && !flags.includes('clamped')) flags.push('clamped');
  return { dNorm: clamped, flags };
}

/** Selisih (b - a) bila menang a dan seri bila selisih <= TIE_MS + u_a + u_b. */
export function tieMargin(tieMs: number, uA: number, uB: number): number {
  return tieMs + Math.max(0, uA) + Math.max(0, uB);
}

export function rankPresses(presses: PressInput[], tieMs = 15): RankResult {
  const normalized = presses.map((p) => {
    const { dNorm, flags } = normalizePress(p);
    return { teamId: p.teamId, dRaw: p.d, dNorm, u: p.u, flags };
  });

  normalized.sort((a, b) => (a.dNorm === b.dNorm ? a.teamId.localeCompare(b.teamId) : a.dNorm - b.dNorm));

  const winner = normalized[0];
  const marginMs = winner ? tieMargin(tieMs, winner.u, winner.u) : 0;
  const tied = winner
    ? normalized.filter((p) => p.teamId !== winner.teamId && p.dNorm - winner.dNorm <= tieMargin(tieMs, winner.u, p.u))
    : [];

  return {
    ranking: normalized.map((p, i) => ({
      ...p,
      rank: i + 1,
      gapMs: winner ? Math.round((p.dNorm - winner.dNorm) * 10) / 10 : 0,
    })),
    tie: tied.length > 0,
    tiedTeamIds: tied.map((p) => p.teamId),
    winnerTeamId: normalized[0]?.teamId ?? null,
    marginMs: winner && tied[0] ? Math.round(tieMargin(tieMs, winner.u, tied[0].u) * 10) / 10 : marginMs,
  };
}
