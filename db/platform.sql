-- PlatformDO: admin, sesi, registry lomba. Satu instance "platform".
CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator',
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  display_mode TEXT NOT NULL DEFAULT 'top1',
  lead_ms INTEGER NOT NULL DEFAULT 900,
  decision_ms INTEGER NOT NULL DEFAULT 220,
  tie_ms INTEGER NOT NULL DEFAULT 15,
  ready_max_u_ms INTEGER NOT NULL DEFAULT 150,
  points_per_round INTEGER NOT NULL DEFAULT 100,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
