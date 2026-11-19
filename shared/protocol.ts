export type Role = 'team' | 'admin' | 'screen';
export type EventStatus = 'draft' | 'open' | 'live' | 'closed' | 'finished';
export type DisplayMode = 'top1' | 'all';
export type AttemptStatus = 'open' | 'closed' | 'settled' | 'void';
export type RoundStatus = 'idle' | 'open' | 'settled' | 'void';
export type AdminRole = 'owner' | 'operator';

export interface EventMeta {
  id: string;
  name: string;
  code: string;
  status: EventStatus;
  displayMode: DisplayMode;
  leadMs: number;
  decisionMs: number;
  tieMs: number;
  readyMaxUMs: number;
  pointsPerRound: number;
}

export interface TeamPublic {
  id: string;
  name: string;
  score: number;
  online: boolean;
  lastSeenAt: number;
  rttMinMs: number | null;
}

export interface RoundInfo {
  id: string;
  seq: number;
  status: RoundStatus;
  awardedTeamId: string | null;
  result: 'correct' | 'void' | null;
  points: number;
}

export interface AttemptInfo {
  id: string;
  roundId: string;
  idx: number;
  openAt: number;
  closeAt: number | null;
  nonce: string;
  status: AttemptStatus;
  candidateIdx: number;
}

export interface RankingEntry {
  teamId: string;
  name: string;
  rank: number;
  dNorm: number;
  dRaw: number;
  u: number;
  flags: string[];
  gapMs: number;
  /** perkiraan waktu tempuh kiriman (tiba - klaim), ms — tanda jaringan lambat */
  deliveryMs: number;
  /** tekan ini wajib dikonfirmasi operator sebelum diberi poin */
  needsReview: boolean;
}

export interface Snapshot {
  appVersion: string;
  serverTime: number;
  event: EventMeta;
  teams: TeamPublic[];
  round: RoundInfo | null;
  attempt: AttemptInfo | null;
  ranking: RankingEntry[];
  tie: boolean;
  tiedTeamIds: string[];
  candidateTeamId: string | null;
  audit: AuditEntry[];
  /** tim yang socket-nya hidup, sync baru, dan u ≤ ambang siap */
  readyTeamIds: string[];
}

export interface AuditEntry {
  id: string;
  adminId: string | null;
  action: string;
  payload: unknown;
  createdAt: number;
}

export type ClientMessage =
  | { type: 'hello'; role: Role; token?: string; teamId?: string; appVersion: string }
  | { type: 'sync'; seq: number; t0: number; u?: number }
  | { type: 'press'; attemptId: string; nonce: string; d: number; u: number }
  | { type: 'ping'; t0: number };

export type ServerMessage =
  | { type: 'hello.ok'; role: Role; teamId?: string; appVersion: string; serverTime: number }
  | { type: 'hello.err'; code: 'bad_role' | 'bad_token' | 'no_team' | 'version' | 'kicked' | 'deleted'; message: string }
  | { type: 'sync-ack'; seq: number; t0: number; t1: number; t2: number }
  | { type: 'pong'; t0: number; t1: number }
  | { type: 'state'; snapshot: Snapshot }
  | { type: 'attempt.opened'; attemptId: string; openAt: number; nonce: string; leadMs: number; roundSeq: number }
  | { type: 'press.ack'; attemptId: string; status: 'received' | 'early' | 'closed' | 'dup' | 'invalid'; d?: number }
  | { type: 'press.rejected'; attemptId: string; status: 'early' | 'closed' | 'dup' | 'invalid'; message: string }
  | { type: 'attempt.ranked'; attemptId: string; ranking: RankingEntry[]; tie: boolean; tiedTeamIds: string[]; candidateIdx: number; candidateTeamId: string | null }
  | { type: 'attempt.candidate'; candidateIdx: number; teamId: string | null }
  | { type: 'round.opened'; round: RoundInfo | null }
  | { type: 'round.settled'; round: RoundInfo | null; scores: Record<string, number> }
  | { type: 'round.void'; round: RoundInfo | null }
  | { type: 'teams.updated'; teams: TeamPublic[] }
  | { type: 'display.mode'; mode: DisplayMode }
  | { type: 'event.updated'; event: EventMeta }
  | { type: 'error'; message: string };

export interface JoinResult {
  teamId: string;
  token: string;
  teamName: string;
  eventCode: string;
  eventId: string;
  eventName: string;
}

export const APP_VERSION = '1.0.0';
export const SYNC_SAMPLES = 7;
export const SYNC_INTERVAL_MS = 15_000;
export const PRESENCE_TIMEOUT_MS = 20_000;
export const READY_SYNC_MAX_AGE_MS = 20_000;
