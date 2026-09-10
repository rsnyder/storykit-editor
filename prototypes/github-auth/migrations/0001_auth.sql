CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_states_expiry ON oauth_states(expires_at);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  login TEXT NOT NULL,
  token TEXT NOT NULL,
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);

-- A lease serializes saves across tabs and Worker instances. Blob SHAs still
-- protect against writes made outside this prototype.
CREATE TABLE write_locks (
  lock_key TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
