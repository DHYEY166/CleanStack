-- Phase A2: Missing composite indexes for hot-path queries
-- Run with CONCURRENTLY — safe on live data, no table lock

-- Billing: getMonthlyUsage JOIN query (fired on every upload + suggest-transforms)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pipeline_runs_pipeline_created
  ON pipeline_runs (pipeline_id, created_at)
  WHERE iteration = 1;

-- Reconciler cron: stuck run cleanup query
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pipeline_runs_active_status
  ON pipeline_runs (status, created_at)
  WHERE status IN ('profiling', 'awaiting_ai', 'queued', 'running');

-- Child run lookup: run-status API returns child_run_id for auto-iterate redirect
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pipeline_runs_parent_run_id
  ON pipeline_runs (parent_run_id)
  WHERE parent_run_id IS NOT NULL;

-- Auto-validate: fetches pending rules per run
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transform_rules_run_status
  ON transform_rules (run_id, status);

-- Suggest-transforms + run page: fetches raw/processed profile per run
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_data_profiles_run_stage
  ON data_profiles (run_id, stage);
