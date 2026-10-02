-- CleanStack Aurora PostgreSQL Schema

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Pipeline definitions
CREATE TABLE IF NOT EXISTS pipelines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  owner_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  template_id UUID,
  data_retention_days INTEGER DEFAULT 30,
  auto_delete_raw BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Each pipeline run (job)
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id UUID REFERENCES pipelines(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','profiling','awaiting_ai','queued','running','completed','failed','awaiting_approval')),
  file_format TEXT,
  mode TEXT DEFAULT 'tabular',
  raw_s3_key TEXT NOT NULL,
  processed_s3_key TEXT,
  row_count_raw INTEGER,
  row_count_processed INTEGER,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  iteration INTEGER NOT NULL DEFAULT 1,
  parent_run_id UUID REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  auto_mode BOOLEAN NOT NULL DEFAULT FALSE
);

-- Data quality profile (before & after)
CREATE TABLE IF NOT EXISTS data_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  quality_score INTEGER,
  total_rows INTEGER,
  null_percentage NUMERIC(5,2),
  duplicate_percentage NUMERIC(5,2),
  type_mismatch_count INTEGER,
  outlier_count INTEGER,
  column_stats JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- AI-suggested + user-approved transform rules
CREATE TABLE IF NOT EXISTS transform_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id UUID REFERENCES pipelines(id) ON DELETE CASCADE,
  run_id UUID REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  rule_type TEXT NOT NULL,
  column_name TEXT,
  parameters JSONB,
  ai_reasoning TEXT,
  status TEXT DEFAULT 'pending',
  order_index INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Approval workflow ("Data PR")
CREATE TABLE IF NOT EXISTS approval_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  reviewer_id TEXT NOT NULL,
  action TEXT NOT NULL,
  comment TEXT,
  rule_changes JSONB,
  reviewed_at TIMESTAMPTZ DEFAULT now()
);

-- Schema snapshots for drift detection
CREATE TABLE IF NOT EXISTS schema_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id UUID REFERENCES pipelines(id) ON DELETE CASCADE,
  run_id UUID REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  schema_hash TEXT NOT NULL,
  column_definitions JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Shareable pipeline templates
CREATE TABLE IF NOT EXISTS pipeline_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  author_id TEXT NOT NULL,
  is_public BOOLEAN DEFAULT false,
  use_count INTEGER DEFAULT 0,
  transform_rules JSONB NOT NULL,
  sample_input_schema JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Output destination config per pipeline
CREATE TABLE IF NOT EXISTS pipeline_destinations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id UUID REFERENCES pipelines(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  config JSONB NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Subscriptions (row-based metered billing)
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','team','enterprise')),
  status TEXT NOT NULL DEFAULT 'active',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', now()),
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- AI usage metering + spend caps (also applied via 002_ai_usage_tables.sql migration)
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
CREATE INDEX IF NOT EXISTS idx_bedrock_usage_created
  ON bedrock_usage (created_at);

CREATE TABLE IF NOT EXISTS ai_spend_limits (
  team_id TEXT PRIMARY KEY,
  soft_cap_usd NUMERIC(10,2) NOT NULL DEFAULT 50,
  hard_cap_usd NUMERIC(10,2) NOT NULL DEFAULT 200,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (soft_cap_usd >= 0 AND hard_cap_usd >= soft_cap_usd)
);

-- Guest sessions (also applied via 003_guest_sessions.sql)
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

-- Indexes
CREATE INDEX IF NOT EXISTS idx_pipelines_team_id ON pipelines(team_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pipeline_id ON pipeline_runs(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status);
CREATE INDEX IF NOT EXISTS idx_transform_rules_run_id ON transform_rules(run_id);
CREATE INDEX IF NOT EXISTS idx_data_profiles_run_id ON data_profiles(run_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_team_id ON subscriptions(team_id);

-- Composite indexes for hot-path queries (also applied via 001_indexes.sql migration)
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pipeline_created
  ON pipeline_runs (pipeline_id, created_at) WHERE iteration = 1;
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_active_status
  ON pipeline_runs (status, created_at)
  WHERE status IN ('profiling', 'awaiting_ai', 'queued', 'running');
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_parent_run_id
  ON pipeline_runs (parent_run_id) WHERE parent_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transform_rules_run_status
  ON transform_rules (run_id, status);
CREATE INDEX IF NOT EXISTS idx_data_profiles_run_stage
  ON data_profiles (run_id, stage);
