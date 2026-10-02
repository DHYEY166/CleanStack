-- 003: guest access (src/lib/guest.ts).
-- One row per guest session. Guest data itself lives in the normal tables with
-- team_id = the guest id; this table backs the per-IP and global guest caps
-- and the 24 h purge (/api/cron/purge-guests). ip_hash is an HMAC of the IP,
-- never the address. Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS guest_sessions (
  id TEXT PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (left(id, 6) = 'guest_')
);

CREATE INDEX IF NOT EXISTS idx_guest_sessions_ip_created
  ON guest_sessions (ip_hash, created_at);

CREATE INDEX IF NOT EXISTS idx_guest_sessions_created
  ON guest_sessions (created_at);

CREATE INDEX IF NOT EXISTS idx_guest_sessions_expires
  ON guest_sessions (expires_at);
