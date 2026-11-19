/**
 * ranking tekan — modul murni, dipakai server dan uji.
 *
 * Klien merekam `d` = performance.now() - openAtLocal saat pointerdown.
 * Server tidak membandingkan waktu terima; ia memvalidasi `d` terhadap
 * jendela fisika lalu memberi peringkat berdasarkan `dNorm`.
 *
 * Aturan penting (lihat src/pages/Fairness.tsx): klaim klien TIDAK dinaikkan.
 * Versi lama menaikkan `d` ke lantai fisika (`recvDelta - u - 30`), sehingga
 * peserta dengan uplink lambat mendapat angka reaksi yang lebih buruk daripada
 * klaimnya sendiri — jaringan ikut menilai, tepat yang dijanjikan tidak
 * terjadi. Kini lantai fisika hanya memberi flag `impossible_fast` untuk
 * diperiksa operator; `dNorm` memakai klaim apa adanya, dijepit 0..batas atas.
 */

export const EARLY_SLACK_MS = 30;
export const LATE_SLACK_MS = 30;

/**
 * Plafon kelonggaran jendela fisika. Disamakan dengan ambang kesiapan default
 * (READY_MAX_U_MS = 150) supaya tim yang dinyatakan siap tidak dianggap mustahil,
 * sekaligus membatasi keuntungan klien yang memalsukan `u`.
 */
export const MAX_FLOOR_ALLOWANCE_MS = 150;

/**
 * Masa tenggang kiriman tertunda. Peserta dengan uplink lambat atau yang
 * sambungannya putus sesaat boleh menekan tepat saat tombol menyala, lalu
 * kirimannya baru tiba setelah `close_at`. Selama operator belum memberi poin,
 * tekan itu tetap diterima dan urutannya disiarkan ulang.
 */
export const LATE_DELIVERY_GRACE_MS = 20_000;

export type PressFlag = 'impossible_fast' | 'impossible_slow' | 'late' | 'clamped';

/** Flag yang membuat sebuah tekan wajib dikonfirmasi operator sebelum diberi poin. */
const REVIEW_FLAGS = ['impossible_fast', 'impossible_slow', 'late', 'clamped'] as const;

export interface PressRaw {
  teamId: string;
  /** klaim reaksi klien, ms sejak openAt (bisa negatif) */
  d: number;
  /** ketidakpastian offset klien, ms */
  u: number;
  /** recvServer - openAt, ms — batas atas fisika */
  recvDelta: number;
}

export type PressInput = PressRaw;

export interface RankedPress {
  teamId: string;
  rank: number;
  dRaw: number;
  dNorm: number;
  u: number;
  flags: PressFlag[];
  /** tekan ini perlu konfirmasi operator sebelum diberi poin */
  needsReview: boolean;
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

/**
 * Normalisasi klaim: hanya menjepit ke rentang yang mungkin (0 sampai batas
 * atas fisika). Tidak pernah menaikkan klaim, karena itu menghukum peserta yang
 * jarinya lebih cepat hanya gara-gara uplink-nya lambat.
 */
export function normalizePress(input: PressInput): { dNorm: number; flags: PressFlag[] } {
  const flags: PressFlag[] = [];
  const rawU = Number.isFinite(input.u) ? Math.max(0, input.u) : 0;
  const allowance = Math.min(rawU, MAX_FLOOR_ALLOWANCE_MS);
  const travelFloor = input.recvDelta - allowance - EARLY_SLACK_MS;
  const travelCeil = input.recvDelta + allowance + LATE_SLACK_MS;

  let d = input.d;
  if (!Number.isFinite(d)) {
    d = input.recvDelta;
    flags.push('clamped');
  }

  // Klaim di bawah nol mustahil (sebelum tombol menyala), dan klaim di atas
  // batas atas tidak bisa dipercaya. Keduanya ditandai, bukan "diperbaiki"
  // dengan menaikkan klaim.
  if (d < travelFloor) flags.push('impossible_fast');
  if (d > travelCeil) flags.push('impossible_slow');

  const dNorm = Math.min(travelCeil, Math.max(0, d));
  if (dNorm !== d && !flags.includes('clamped')) flags.push('clamped');
  return { dNorm, flags };
}

export function pressNeedsReview(flags: readonly string[]): boolean {
  return flags.some((flag) => (REVIEW_FLAGS as readonly string[]).includes(flag));
}

export interface PressWindowInput {
  now: number;
  openAt: number;
  closeAt: number | null;
  /** ronde sudah diberi poin / dibatalkan — tidak menerima tekan lagi */
  awarded: boolean;
  graceMs?: number;
}

export interface PressWindowResult {
  accept: boolean;
  /** tiba setelah `close_at`; tetap sah tetapi wajib diperiksa operator */
  late: boolean;
  reason: 'early' | 'closed' | 'awarded' | null;
}

/**
 * Jendela penerimaan tekan. Batasnya bukan lagi `close_at` semata: kiriman
 * yang tertunda di jaringan tetap diterima sampai `close_at + graceMs` selama
 * ronde belum dinilai.
 */
export function pressWindow(input: PressWindowInput): PressWindowResult {
  const graceMs = Number.isFinite(input.graceMs) ? Math.max(0, Number(input.graceMs)) : LATE_DELIVERY_GRACE_MS;
  if (input.awarded) return { accept: false, late: false, reason: 'awarded' };
  if (input.now < input.openAt) return { accept: false, late: false, reason: 'early' };
  if (input.closeAt !== null && input.now > input.closeAt + graceMs) {
    return { accept: false, late: true, reason: 'closed' };
  }
  return { accept: true, late: input.closeAt !== null && input.now > input.closeAt, reason: null };
}

/** Selisih (b - a) bila menang a dan seri bila selisih <= TIE_MS + u_a + u_b. */
export function tieMargin(tieMs: number, uA: number, uB: number): number {
  return tieMs + Math.max(0, uA) + Math.max(0, uB);
}

/** Operator harus mengirim `teamId` pilihan sendiri beserta `explicit: true`. */
export function requiresExplicitChoice(payload: { teamId?: unknown; explicit?: unknown }): boolean {
  return typeof payload.teamId !== 'string' || payload.teamId.length === 0 || payload.explicit !== true;
}

/**
 * Seri teknis tidak boleh diputuskan server: tanpa pilihan eksplisit kandidat
 * default (urutan abjad ranking) menang tanpa pernah dipilih siapa pun.
 */
export function tieRequiresChoice(tie: boolean, payload: { teamId?: unknown; explicit?: unknown }): boolean {
  if (!tie) return false;
  return requiresExplicitChoice(payload);
}

export function rankPresses(presses: PressInput[], tieMs = 15): RankResult {
  const normalized = presses.map((p) => {
    const { dNorm, flags } = normalizePress(p);
    return { teamId: p.teamId, dRaw: p.d, dNorm, u: p.u, flags, needsReview: pressNeedsReview(flags) };
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
