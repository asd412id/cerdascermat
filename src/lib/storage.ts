export interface TeamSession {
  teamId: string;
  token: string;
  teamName: string;
  eventCode: string;
  eventId: string;
  eventName: string;
  joinedAt: number;
}

const TEAM_KEY = 'cc.team.v1';
const LAST_TEAM_KEY = 'cc.team.last.v1';
const ADMIN_KEY = 'cc.admin.token.v1';
const ADMIN_EVENT_KEY = 'cc.admin.event.v1';
const SCREEN_CODE_KEY = 'cc.screen.code.v1';
const SCREEN_SOUND_KEY = 'cc.screen.sound.v1';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function loadTeamSession(): TeamSession | null {
  const raw = read(TEAM_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as TeamSession;
    if (!parsed.teamId || !parsed.token || !parsed.eventCode) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveTeamSession(session: TeamSession): void {
  try {
    localStorage.setItem(TEAM_KEY, JSON.stringify(session));
    localStorage.setItem(LAST_TEAM_KEY, JSON.stringify(session));
  } catch {
    // mode privat bisa menolak; sesi tetap hidup di memori halaman ini
  }
}

export function clearTeamSession(): void {
  try {
    localStorage.removeItem(TEAM_KEY);
  } catch {
    // abaikan
  }
}

/**
 * Tim yang terakhir dipakai di perangkat ini. Sengaja tidak ikut dihapus saat
 * peserta menekan "Keluar tim", supaya bisa masuk kembali ke tim yang sama
 * walaupun sesi aktifnya sudah dilepas.
 */
export function loadLastTeam(): TeamSession | null {
  const raw = read(LAST_TEAM_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as TeamSession;
    if (!parsed.teamId || !parsed.token || !parsed.eventCode) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearLastTeam(): void {
  try {
    localStorage.removeItem(LAST_TEAM_KEY);
  } catch {
    // abaikan
  }
}

export function loadAdminToken(): string | null {
  try {
    return sessionStorage.getItem(ADMIN_KEY);
  } catch {
    return null;
  }
}

export function saveAdminToken(token: string): void {
  try {
    sessionStorage.setItem(ADMIN_KEY, token);
  } catch {
    // abaikan
  }
}

export function clearAdminToken(): void {
  try {
    sessionStorage.removeItem(ADMIN_KEY);
  } catch {
    // abaikan
  }
}

export function loadAdminEventId(): string | null {
  return read(ADMIN_EVENT_KEY);
}

export function saveAdminEventId(id: string): void {
  try {
    localStorage.setItem(ADMIN_EVENT_KEY, id);
  } catch {
    // abaikan
  }
}

export function loadScreenCode(): string | null {
  return read(SCREEN_CODE_KEY);
}

export function saveScreenCode(code: string): void {
  try {
    localStorage.setItem(SCREEN_CODE_KEY, code);
  } catch {
    // abaikan
  }
}

/** Suara bel papan skor; default mati agar tidak mengagetkan saat layar dibuka. */
export function loadScreenSound(): boolean {
  return read(SCREEN_SOUND_KEY) === 'on';
}

export function saveScreenSound(on: boolean): void {
  try {
    localStorage.setItem(SCREEN_SOUND_KEY, on ? 'on' : 'off');
  } catch {
    // abaikan
  }
}
