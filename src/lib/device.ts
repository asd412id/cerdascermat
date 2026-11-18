export function vibrate(pattern: number | number[]): void {
  try {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(pattern);
  } catch {
    // iOS Safari tidak mendukung; abaikan
  }
}

interface WakeLockSentinelLike {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: 'release', listener: () => void) => void;
}

interface WakeLockLike {
  request: (type: 'screen') => Promise<WakeLockSentinelLike>;
}

export function wakeLockSupported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

export async function requestScreenWakeLock(): Promise<WakeLockSentinelLike | null> {
  if (!wakeLockSupported()) return null;
  try {
    const api = (navigator as Navigator & { wakeLock: WakeLockLike }).wakeLock;
    return await api.request('screen');
  } catch {
    return null;
  }
}
