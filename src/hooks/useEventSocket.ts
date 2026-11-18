import { useEffect, useRef, useState } from 'react';
import type { ClientMessage, Role, ServerMessage, Snapshot } from '@shared/protocol';
import { EventConnection, type ConnStatus } from '../lib/connection';

export interface ClockView {
  u: number;
  rttMin: number;
  offset: number;
  synced: boolean;
  lastSyncAt: number;
}

/** Gabungkan pesan realtime ke snapshot agar semua layar memakai satu sumber. */
export function applyMessage(previous: Snapshot | null, message: ServerMessage): Snapshot | null {
  switch (message.type) {
    case 'state':
      return message.snapshot;
    case 'teams.updated':
      return previous ? { ...previous, teams: message.teams } : previous;
    case 'event.updated':
      return previous ? { ...previous, event: message.event } : previous;
    case 'display.mode':
      return previous ? { ...previous, event: { ...previous.event, displayMode: message.mode } } : previous;
    case 'attempt.opened':
      return previous
        ? {
            ...previous,
            attempt: {
              id: message.attemptId,
              roundId: previous.attempt?.roundId ?? previous.round?.id ?? '',
              idx: (previous.attempt?.idx ?? -1) + 1,
              openAt: message.openAt,
              closeAt: null,
              nonce: message.nonce,
              status: 'open',
              candidateIdx: 0,
            },
            ranking: [],
            tie: false,
            tiedTeamIds: [],
            candidateTeamId: null,
          }
        : previous;
    case 'attempt.ranked':
      return previous
        ? {
            ...previous,
            ranking: message.ranking,
            tie: message.tie,
            tiedTeamIds: message.tiedTeamIds,
            candidateTeamId: message.candidateTeamId,
            attempt: previous.attempt ? { ...previous.attempt, status: 'closed', candidateIdx: message.candidateIdx } : previous.attempt,
          }
        : previous;
    case 'attempt.candidate':
      return previous
        ? {
            ...previous,
            candidateTeamId: message.teamId,
            attempt: previous.attempt ? { ...previous.attempt, candidateIdx: message.candidateIdx } : previous.attempt,
          }
        : previous;
    case 'round.opened':
      return previous ? { ...previous, round: message.round } : previous;
    case 'round.settled':
      return previous
        ? {
            ...previous,
            round: message.round,
            teams: previous.teams.map((team) => ({ ...team, score: message.scores[team.id] ?? team.score })),
          }
        : previous;
    case 'round.void':
      return previous ? { ...previous, round: message.round } : previous;
    default:
      return previous;
  }
}

export interface UseEventSocketOptions {
  code: string | undefined;
  role: Role;
  token?: string;
  teamId?: string;
  enabled?: boolean;
  onMessage?: (message: ServerMessage) => void;
}

export function useEventSocket(options: UseEventSocketOptions) {
  const { code, role, token, teamId, enabled = true } = options;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState<ConnStatus>('idle');
  const [detail, setDetail] = useState('belum terhubung');
  const [clock, setClock] = useState<ClockView>({ u: Number.POSITIVE_INFINITY, rttMin: Number.POSITIVE_INFINITY, offset: 0, synced: false, lastSyncAt: 0 });
  const handlerRef = useRef(options.onMessage);
  handlerRef.current = options.onMessage;
  const connRef = useRef<EventConnection | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!code || !enabled) {
      setStatus('idle');
      return;
    }
    // Lomba berganti: buang snapshot lama agar layar tidak menampilkan data lomba sebelumnya.
    setSnapshot(null);
    const connection = new EventConnection({
      code,
      role,
      token,
      teamId,
      onStatus: (next, note) => {
        setStatus(next);
        setDetail(note);
      },
      onClock: (serverClock) => {
        setClock({
          u: serverClock.u,
          rttMin: serverClock.rttMin,
          offset: serverClock.offset,
          synced: serverClock.synced,
          lastSyncAt: serverClock.lastSyncAt,
        });
      },
      onMessage: (message) => {
        setSnapshot((previous) => applyMessage(previous, message));
        handlerRef.current?.(message);
      },
    });
    connRef.current = connection;
    connection.connect();

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        if (connection.status !== 'open') connection.reconnectNow();
        else void connection.syncRound();
      }
    };
    const onOnline = () => {
      if (connection.status !== 'open') connection.reconnectNow();
      else void connection.syncRound();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      connection.close();
      connRef.current = null;
    };
  }, [code, role, token, teamId, enabled, generation]);

  const send = (message: ClientMessage) => connRef.current?.send(message);
  const reconnect = () => {
    if (connRef.current) connRef.current.reconnectNow();
    else setGeneration((n) => n + 1);
  };
  const resync = () => void connRef.current?.syncRound();

  return { snapshot, setSnapshot, status, detail, clock, send, reconnect, resync };
}
