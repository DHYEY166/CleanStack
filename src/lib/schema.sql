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
  status TEXT DEFAULT 'pending',
  file_format TEXT,
  raw_s3_key TEXT NOT NULL,
  processed_s3_key TEXT,
  row_count_raw INTEGER,
  row_count_processed INTEGER,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
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

-- Indexes
CREATE INDEX IF NOT EXISTS idx_pipelines_team_id ON pipelines(team_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pipeline_id ON pipeline_runs(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status);
CREATE INDEX IF NOT EXISTS idx_transform_rules_run_id ON transform_rules(run_id);
CREATE INDEX IF NOT EXISTS idx_data_profiles_run_id ON data_profiles(run_id);
