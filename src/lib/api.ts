export interface ApiErrorBody {
  error?: string;
  message?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const envBase = (import.meta.env.VITE_API_BASE as string | undefined)?.trim().replace(/\/$/, '');

export const API_BASE =
  envBase && envBase.length > 0
    ? envBase
    : typeof location !== 'undefined' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
      ? 'http://localhost:8787'
      : '';

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export function wsUrl(code: string): string {
  const base = API_BASE || (typeof location !== 'undefined' ? location.origin : 'http://localhost:8787');
  const url = new URL(base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `/ws/event/${encodeURIComponent(code)}`;
  url.search = '';
  return url.toString();
}

export async function api<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type') && init.body) headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetch(apiUrl(path), { ...init, headers });
  } catch {
    throw new ApiError(0, 'network', 'Tidak bisa menghubungi server. Coba lagi.');
  }
  const text = await response.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    const errorBody = body as ApiErrorBody;
    throw new ApiError(response.status, errorBody.error ?? 'http_error', errorBody.message ?? `Permintaan gagal (${response.status}).`);
  }
  return body as T;
}

export async function checkHealth(): Promise<{ ok: boolean; version: string; ms: number }> {
  const started = performance.now();
  const body = await api<{ ok: boolean; version: string }>('/api/health');
  return { ok: body.ok, version: body.version, ms: Math.round(performance.now() - started) };
}
