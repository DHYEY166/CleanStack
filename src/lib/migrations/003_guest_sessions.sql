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

-- checkAiBudget (src/lib/bedrock-meter.ts) sums today's spend of all guests
-- (team_id LIKE 'guest\_%' AND created_at >= today) before every guest AI call.
CREATE INDEX IF NOT EXISTS idx_bedrock_usage_created
  ON bedrock_usage (created_at);

-- "Try with sample data" template (src/lib/sample-data.ts: same id and rules,
-- checked by sample-data.test.ts). Not public, so it is not in the gallery.
-- A sample run uses these rules and never calls Bedrock.
INSERT INTO pipeline_templates (id, name, description, category, author_id, is_public, transform_rules)
VALUES (
  'c1ea0000-5a3d-4e00-8000-000000000001',
  'Sample orders cleanup',
  'Cleans the bundled sample orders file: whitespace, duplicates, statuses, amounts and dates.',
  'demo',
  'system',
  false,
  '[{"rule_type":"trim_whitespace","column_name":null,"parameters":{},"ai_reasoning":"Several customer and status values have leading or trailing spaces."},{"rule_type":"deduplicate","column_name":null,"parameters":{},"ai_reasoning":"Orders 1004 and 1011 appear twice with identical values."},{"rule_type":"fill_nulls","column_name":"status","parameters":{"strategy":"value","value":"unknown"},"ai_reasoning":"Two orders have no status."},{"rule_type":"normalize","column_name":"status","parameters":{},"ai_reasoning":"Status mixes SHIPPED, shipped and Shipped."},{"rule_type":"type_cast","column_name":"amount","parameters":{"target_type":"float"},"ai_reasoning":"Amounts carry dollar signs and thousands separators, which blocks numeric totals."},{"rule_type":"normalize","column_name":"order_date","parameters":{},"ai_reasoning":"Dates mix ISO, US and slash formats."}]'::jsonb
)
ON CONFLICT (id) DO NOTHING;
