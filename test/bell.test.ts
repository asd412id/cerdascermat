import { afterEach, describe, expect, it, vi } from 'vitest';
import { pressBellKey } from '../src/lib/bell';

const alfa = { teamId: 'tim-alfa' };
const beta = { teamId: 'tim-beta' };

describe('pressBellKey', () => {
  it('kosong saat belum ada tekanan', () => {
    expect(pressBellKey('att-1', [])).toBe('');
    expect(pressBellKey(null, [alfa])).toBe('');
  });

  it('stabil untuk daftar tekan yang sama', () => {
    expect(pressBellKey('att-1', [alfa, beta])).toBe(pressBellKey('att-1', [alfa, beta]));
  });

  it('berubah saat peserta lain ikut menekan', () => {
    expect(pressBellKey('att-1', [alfa, beta])).not.toBe(pressBellKey('att-1', [alfa]));
  });

  it('berubah saat urutan teratas berganti', () => {
    expect(pressBellKey('att-1', [beta, alfa])).not.toBe(pressBellKey('att-1', [alfa, beta]));
  });

  it('berbeda antar ronde walau susunannya sama', () => {
    expect(pressBellKey('att-2', [alfa])).not.toBe(pressBellKey('att-1', [alfa]));
  });
});

/** Audio palsu: cukup mencatat panggilan untuk membuktikan nada benar dibangkitkan. */
class FakeParam {
  calls: Array<{ kind: 'set' | 'ramp'; value: number; at: number }> = [];
  setValueAtTime(value: number, at: number) {
    this.calls.push({ kind: 'set', value, at });
  }
  exponentialRampToValueAtTime(value: number, at: number) {
    this.calls.push({ kind: 'ramp', value, at });
  }
}

class FakeNode {
  gain = new FakeParam();
  frequency = new FakeParam();
  type = 'sine';
  starts: number[] = [];
  stops: number[] = [];
  connect(): this {
    return this;
  }
  start(at: number) {
    this.starts.push(at);
  }
  stop(at: number) {
    this.stops.push(at);
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: 'suspended' | 'running' = 'suspended';
  currentTime = 5;
  destination = new FakeNode();
  oscillators: FakeNode[] = [];
  gains: FakeNode[] = [];

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  async resume() {
    this.state = 'running';
  }

  createOscillator() {
    const node = new FakeNode();
    this.oscillators.push(node);
    return node;
  }

  createGain() {
    const node = new FakeNode();
    this.gains.push(node);
    return node;
  }
}

async function loadBell() {
  vi.resetModules();
  return import('../src/lib/bell');
}

describe('bel WebAudio', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeAudioContext.instances = [];
  });

  it('tidak berbunyi sebelum audio dibuka gestur pengguna', async () => {
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    const bell = await loadBell();
    expect(bell.ringBell()).toBe(false);
    expect(FakeAudioContext.instances[0]?.oscillators ?? []).toHaveLength(0);
  });

  it('membuka konteks audio lalu membunyikan dua pukulan', async () => {
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    const bell = await loadBell();

    await expect(bell.primeBell()).resolves.toBe(true);
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(bell.ringBell()).toBe(true);

    const ctx = FakeAudioContext.instances[0];
    // 4 parsial × 2 pukulan: bel logam, bukan satu nada sinus.
    expect(ctx.oscillators).toHaveLength(8);
    const starts = [...new Set(ctx.oscillators.map((osc) => osc.starts[0]))].sort((a, b) => a - b);
    expect(starts).toHaveLength(2);
    expect(starts[1] - starts[0]).toBeCloseTo(0.19, 5);
    // Tiap parsial diserang cepat lalu luruh; nilai ramp tidak boleh 0 (eksponensial).
    expect(ctx.gains).toHaveLength(8);
    for (const amp of ctx.gains) {
      expect(amp.gain.calls).toHaveLength(3);
      expect(amp.gain.calls.every((call) => call.value > 0)).toBe(true);
    }
    for (const osc of ctx.oscillators) {
      expect(osc.frequency.calls[0].value).toBeGreaterThan(1000);
    }
  });

  it('aman bila peramban tidak punya WebAudio', async () => {
    vi.stubGlobal('window', {});
    const bell = await loadBell();
    await expect(bell.primeBell()).resolves.toBe(false);
    expect(bell.ringBell()).toBe(false);
  });
});
