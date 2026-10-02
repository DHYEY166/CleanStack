-- 002: AI usage metering + spend caps.
-- bedrock_usage / ai_spend_limits were used by src/lib/bedrock-meter.ts,
-- /api/admin/ai-spend and DELETE /api/account but never created by schema.sql,
-- so metering inserts failed silently and the spend cap always read $0.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS bedrock_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id TEXT NOT NULL,
  run_id UUID,
  model TEXT NOT NULL,
  call_type TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bedrock_usage_team_created
  ON bedrock_usage (team_id, created_at);

CREATE TABLE IF NOT EXISTS ai_spend_limits (
  team_id TEXT PRIMARY KEY,
  soft_cap_usd NUMERIC(10,2) NOT NULL DEFAULT 50,
  hard_cap_usd NUMERIC(10,2) NOT NULL DEFAULT 200,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (soft_cap_usd >= 0 AND hard_cap_usd >= soft_cap_usd)
);
