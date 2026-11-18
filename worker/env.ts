import type { PlatformDO } from './platform';
import type { EventDO } from './event';

export interface Env {
  PLATFORM: DurableObjectNamespace<PlatformDO>;
  EVENT: DurableObjectNamespace<EventDO>;
  ALLOWED_ORIGINS: string;
  ALLOW_ADMIN_SIGNUP: string;
  SESSION_TTL_HOURS: string;
  LEAD_MS?: string;
  DECISION_MS?: string;
  TIE_MS?: string;
  READY_MAX_U_MS?: string;
  OWNER_USERNAME?: string;
  OWNER_PASSWORD?: string;
}

export interface AdminSession {
  adminId: string;
  username: string;
  role: 'owner' | 'operator';
  expiresAt: number;
}

export function splitOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}
