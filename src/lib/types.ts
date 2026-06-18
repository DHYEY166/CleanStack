export type PipelineStatus = "active" | "paused" | "archived";
export type RunStatus =
  | "pending"
  | "profiling"
  | "awaiting_ai"
  | "awaiting_approval"
  | "queued"
  | "running"
  | "completed"
  | "failed";
export type RuleStatus = "pending" | "approved" | "rejected";
export type ProfileStage = "raw" | "processed";

export interface Pipeline {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  team_id: string;
  status: PipelineStatus;
  template_id: string | null;
  data_retention_days: number;
  auto_delete_raw: boolean;
  created_at: string;
  updated_at: string;
}

export interface PipelineRun {
  id: string;
  pipeline_id: string;
  status: RunStatus;
  file_format: string | null;
  raw_s3_key: string;
  processed_s3_key: string | null;
  row_count_raw: number | null;
  row_count_processed: number | null;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  created_at: string;
  iteration: number;
  parent_run_id: string | null;
  auto_mode: boolean;
}

export interface DataProfile {
  id: string;
  run_id: string;
  stage: ProfileStage;
  quality_score: number | null;
  total_rows: number | null;
  null_percentage: number | null;
  duplicate_percentage: number | null;
  type_mismatch_count: number | null;
  outlier_count: number | null;
  column_stats: Record<string, ColumnStat> | null;
  created_at: string;
}

export interface ColumnStat {
  type: string;
  null_count: number;
  null_pct: number;
  unique_count: number;
  sample_values: unknown[];
  min?: unknown;
  max?: unknown;
}

export interface TransformRule {
  id: string;
  pipeline_id: string;
  run_id: string;
  rule_type: string;
  column_name: string | null;
  parameters: Record<string, unknown> | null;
  ai_reasoning: string | null;
  status: RuleStatus;
  order_index: number | null;
  created_at: string;
}

export interface TemplateRule {
  rule_type: string;
  column_name: string | null;
  parameters: Record<string, unknown>;
  ai_reasoning: string;
}

export interface PipelineTemplate {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  author_id: string;
  is_public: boolean;
  use_count: number;
  transform_rules: TemplateRule[];
  sample_input_schema: Record<string, string> | null;
  created_at: string;
}

export interface ApprovalReview {
  id: string;
  run_id: string;
  reviewer_id: string;
  action: "approved" | "rejected" | "commented";
  comment: string | null;
  rule_changes: Record<string, unknown> | null;
  reviewed_at: string;
}
