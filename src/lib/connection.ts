import { APP_VERSION, SYNC_INTERVAL_MS, SYNC_SAMPLES, type ClientMessage, type Role, type ServerMessage } from '@shared/protocol';
import { wsUrl } from './api';
import { ServerClock, computeSample } from './clock';

export type ConnStatus = 'idle' | 'connecting' | 'open' | 'closed';

export interface ConnectionOptions {
  code: string;
  role: Role;
  token?: string;
  teamId?: string;
  onMessage: (message: ServerMessage) => void;
  onStatus: (status: ConnStatus, detail: string) => void;
  onClock: (clock: ServerClock) => void;
}

interface PendingSync {
  seq: number;
  t0: number;
}

const SAMPLE_GAP_MS = 90;
const HEARTBEAT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class EventConnection {
  private ws: WebSocket | null = null;
  private retry = 0;
  private stopped = false;
  private pending = new Map<number, PendingSync>();
  private seq = 0;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private syncing = false;
  private readonly opts: ConnectionOptions;
  readonly clock = new ServerClock();

  constructor(options: ConnectionOptions) {
    this.opts = options;
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  private open(): void {
    this.clearTimers();
    this.opts.onStatus('connecting', 'menghubungkan');
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl(this.opts.code));
    } catch {
      this.scheduleReconnect('alamat realtime tidak sah');
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.opts.onStatus('connecting', 'handshake');
      const hello: ClientMessage = {
        type: 'hello',
        role: this.opts.role,
        token: this.opts.token,
        teamId: this.opts.teamId,
        appVersion: APP_VERSION,
      };
      ws.send(JSON.stringify(hello));
    };
    ws.onmessage = (event) => this.handleMessage(event.data);
    ws.onerror = () => {
      // detail CORS tidak tersedia di browser; status + tombol coba lagi yang menolong
    };
    ws.onclose = () => {
      this.clearTimers();
      this.opts.onStatus('closed', this.stopped ? 'ditutup' : 'terputus');
      if (!this.stopped) this.scheduleReconnect('socket tertutup');
    };
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    const delay = Math.min(8000, 400 * 2 ** this.retry) + Math.random() * 250;
    this.retry += 1;
    this.opts.onStatus('closed', `${reason} · coba lagi ${Math.round(delay)} ms`);
    setTimeout(() => {
      if (!this.stopped) this.open();
    }, delay);
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }

    if (message.type === 'sync-ack') {
      const pending = this.pending.get(message.seq);
      if (pending) {
        this.pending.delete(message.seq);
        const t3 = performance.now();
        this.clock.add(computeSample(pending.t0, message.t1, message.t2, t3));
        this.opts.onClock(this.clock);
      }
      return;
    }

    if (message.type === 'hello.ok') {
      this.opts.onStatus('open', 'terhubung');
      void this.syncRound();
      this.startTimers();
    }

    this.opts.onMessage(message);
  }

  private startTimers(): void {
    this.clearTimers();
    this.syncTimer = setInterval(() => void this.syncRound(), SYNC_INTERVAL_MS);
    this.heartbeat = setInterval(() => this.send({ type: 'ping', t0: performance.now() }), HEARTBEAT_MS);
  }

  private clearTimers(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.syncTimer = null;
    this.heartbeat = null;
  }

  async syncRound(): Promise<void> {
    if (this.syncing || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.syncing = true;
    try {
      for (let i = 0; i < SYNC_SAMPLES; i += 1) {
        const seq = ++this.seq;
        const t0 = performance.now();
        this.pending.set(seq, { seq, t0 });
        this.send({ type: 'sync', seq, t0, u: Number.isFinite(this.clock.bestU) ? this.clock.bestU : undefined });
        await sleep(SAMPLE_GAP_MS);
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) break;
      }
      this.clock.commit();
      this.opts.onClock(this.clock);
    } finally {
      this.syncing = false;
    }
  }

  /**
   * `true` hanya bila frame benar-benar masuk ke socket. Pemanggil (antrean
   * tekan) butuh jawaban ini untuk tahu kapan harus mencoba lagi.
   */
  send(message: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch {
      // biarkan onclose yang menangani
      return false;
    }
  }

  reconnectNow(): void {
    this.retry = 0;
    this.ws?.close();
    if (this.stopped) {
      this.stopped = false;
      this.open();
    }
  }

  close(): void {
    this.stopped = true;
    this.clearTimers();
    this.pending.clear();
    try {
      this.ws?.close();
    } catch {
      // sudah tertutup
    }
    this.ws = null;
    this.opts.onStatus('idle', 'ditutup');
  }

  get status(): ConnStatus {
    if (!this.ws) return 'idle';
    if (this.ws.readyState === WebSocket.OPEN) return 'open';
    if (this.ws.readyState === WebSocket.CONNECTING) return 'connecting';
    return 'closed';
  }
}
