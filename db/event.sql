-- EventDO: satu Durable Object per lomba = satu wasit.
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  token_hash TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  rtt_min_ms REAL
);

CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  awarded_team_id TEXT,
  result TEXT,
  points INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS round_attempts (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  open_at INTEGER NOT NULL,
  close_at INTEGER,
  nonce TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  candidate_idx INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS presses (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  d_ms REAL NOT NULL,
  d_norm_ms REAL NOT NULL,
  u_ms REAL NOT NULL,
  recv_ms INTEGER NOT NULL,
  flags TEXT NOT NULL DEFAULT '[]',
  ordinal INTEGER NOT NULL,
  UNIQUE (attempt_id, team_id)
);

CREATE TABLE IF NOT EXISTS score_edits (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  admin_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  admin_id TEXT,
  action TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
