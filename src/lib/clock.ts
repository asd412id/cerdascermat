/**
 * Sinkronisasi jam ala NTP (RFC 5905 §8):
 *   rtt    = (t3 - t0) - (t2 - t1)
 *   offset = ((t1 - t0) + (t2 - t3)) / 2
 * t0/t3 memakai performance.now() (monotonic), t1/t2 jam server.
 * Sampel dengan RTT terkecil dipakai; `u = rtt / 2` adalah batas galat offset.
 */
export interface SyncSample {
  t0: number;
  t1: number;
  t2: number;
  t3: number;
  rtt: number;
  offset: number;
}

export function computeSample(t0: number, t1: number, t2: number, t3: number): SyncSample {
  const rtt = Math.max(0, t3 - t0 - (t2 - t1));
  const offset = (t1 - t0 + (t2 - t3)) / 2;
  return { t0, t1, t2, t3, rtt, offset };
}

export class ServerClock {
  offset = 0;
  rttMin = Number.POSITIVE_INFINITY;
  u = Number.POSITIVE_INFINITY;
  samples = 0;
  lastSyncAt = 0;
  private roundBest: SyncSample | null = null;

  add(sample: SyncSample): void {
    this.samples += 1;
    this.lastSyncAt = Date.now();
    if (!this.roundBest || sample.rtt < this.roundBest.rtt) this.roundBest = sample;
  }

  commit(): void {
    if (this.roundBest) {
      this.offset = this.roundBest.offset;
      this.rttMin = this.roundBest.rtt;
      this.u = Math.round(this.roundBest.rtt / 2);
    }
    this.roundBest = null;
  }

  /** perkiraan u terbaru, termasuk sampel putaran yang belum di-commit */
  get bestU(): number {
    return this.roundBest ? Math.round(this.roundBest.rtt / 2) : this.u;
  }

  get synced(): boolean {
    return Number.isFinite(this.offset) && this.samples > 0 && this.lastSyncAt > 0;
  }

  /** jam server (epoch ms) menurut estimasi lokal */
  serverNow(): number {
    return performance.now() + this.offset;
  }

  /** ubah waktu server absolut menjadi waktu performance.now() lokal */
  toLocal(serverTime: number): number {
    return serverTime - this.offset;
  }
}
