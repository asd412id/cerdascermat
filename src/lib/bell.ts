/**
 * Bel papan skor. Nada dibangkitkan WebAudio saat dipakai, bukan berkas audio:
 * tidak ada unduhan tambahan, tetap berbunyi walau PWA dipakai tanpa jaringan,
 * dan tidak perlu mengurus izin aset di Firebase Hosting.
 *
 * Peramban mengunci audio sampai ada gestur pengguna, jadi layar wajib memanggil
 * `primeBell()` dari sebuah klik lebih dulu (lihat tombol "bel" di Screen.tsx).
 */

let context: AudioContext | null = null;

type AudioContextCtor = new () => AudioContext;

/** Nada dasar E6 dengan parsial logam khas bel, bukan sinus tunggal. */
const BASE_HZ = 1318.5;
const PARTIALS = [
  { ratio: 1, level: 0.9, decay: 0.7 },
  { ratio: 2.01, level: 0.5, decay: 0.5 },
  { ratio: 3.02, level: 0.26, decay: 0.34 },
  { ratio: 4.35, level: 0.14, decay: 0.22 },
] as const;

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (context) return context;
  const ctor = (window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext) as AudioContextCtor | undefined;
  if (!ctor) return null;
  try {
    context = new ctor();
  } catch {
    return null;
  }
  return context;
}

/** Satu pukulan bel pada waktu tertentu; `volume` 0..1. */
function strike(ctx: AudioContext, at: number, volume: number): void {
  for (const partial of PARTIALS) {
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(BASE_HZ * partial.ratio, at);
    // Serangan 5 ms lalu luruh eksponensial: pendek dan tegas, tidak berdenging
    // panjang menutupi pertanyaan berikutnya.
    amp.gain.setValueAtTime(0.0001, at);
    amp.gain.exponentialRampToValueAtTime(partial.level * volume, at + 0.005);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + partial.decay);
    osc.connect(amp);
    amp.connect(ctx.destination);
    osc.start(at);
    osc.stop(at + partial.decay + 0.02);
  }
}

/**
 * Buka kunci audio dari gestur pengguna. Mengembalikan `true` bila konteks
 * benar-benar berjalan, sehingga layar bisa jujur menampilkan status bel.
 */
export async function primeBell(): Promise<boolean> {
  const ctx = audioContext();
  if (!ctx) return false;
  try {
    if (ctx.state === 'suspended') await ctx.resume();
  } catch {
    return false;
  }
  return ctx.state === 'running';
}

/** Bunyikan bel. `false` berarti audio belum dibuka atau tidak tersedia. */
export function ringBell(): boolean {
  const ctx = audioContext();
  if (!ctx || ctx.state !== 'running') return false;
  const now = ctx.currentTime + 0.02;
  strike(ctx, now, 0.22);
  strike(ctx, now + 0.19, 0.13);
  return true;
}

/**
 * Kunci satu peristiwa tekan: dipakai layar agar bel berbunyi sekali per
 * perubahan ranking (tekanan baru atau urutan teratas berganti), bukan setiap
 * kali server menyiarkan ulang hasil yang sama.
 */
export function pressBellKey(attemptId: string | null | undefined, ranking: readonly { teamId: string }[]): string {
  if (!attemptId || ranking.length === 0) return '';
  return `${attemptId}:${ranking.length}:${ranking[0].teamId}`;
}
