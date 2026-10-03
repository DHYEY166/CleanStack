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

/** Written by the executor into transform_rules.parameters._execution. */
export interface RuleExecutionResult {
  applied: boolean;
  reason: string | null;
  /** Rows this rule removed; null for runs executed before the executor recorded it. */
  rows_removed: number | null;
  /**
   * Rows the rule removed (or, if the bad-cell guard skipped it, would have removed) only
   * because of one bad cell. Null for runs executed before the executor recorded it.
   */
  bad_cell_rows: number | null;
}

/** Execution outcome recorded by the executor, or null if the rule has not run yet. */
export function ruleExecution(parameters: Record<string, unknown> | null | undefined): RuleExecutionResult | null {
  const raw = parameters?._execution;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.applied !== "boolean") return null;
  const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
  return {
    applied: r.applied,
    reason: typeof r.reason === "string" ? r.reason : null,
    rows_removed: count(r.rows_removed),
    bad_cell_rows: count(r.bad_cell_rows),
  };
}

/** Rule types that select rows and can therefore remove whole rows from the output. */
export const ROW_REMOVING_RULES: ReadonlySet<string> = new Set([
  "drop_nulls", "deduplicate", "semantic_deduplicate", "filter", "filter_extended",
]);

export function removesRows(ruleType: string): boolean {
  return ROW_REMOVING_RULES.has(ruleType);
}

/** Total rows the executor recorded as removed by these rules (0 when none were recorded). */
export function rowsRemovedByRules(rules: { parameters: Record<string, unknown> | null }[]): number {
  return rules.reduce((sum, r) => sum + (ruleExecution(r.parameters)?.rows_removed ?? 0), 0);
}

/**
 * Bad-cell guard totals for a run: rows removed only because of one bad cell by rules that
 * were applied, and rows such rules would have removed but the guard kept (auto mode).
 */
export function badCellRowsByRules(rules: { parameters: Record<string, unknown> | null }[]): { removed: number; kept: number } {
  let removed = 0;
  let kept = 0;
  for (const r of rules) {
    const e = ruleExecution(r.parameters);
    if (!e?.bad_cell_rows) continue;
    if (e.applied) removed += e.bad_cell_rows;
    else kept += e.bad_cell_rows;
  }
  return { removed, kept };
}

/** An approved rule the executor skipped (it changed nothing in the output). */
export function isApprovedButNotApplied(rule: { status: string; parameters: Record<string, unknown> | null }): boolean {
  return rule.status === "approved" && ruleExecution(rule.parameters)?.applied === false;
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

export type PlanId = "free" | "pro" | "team";

export interface Subscription {
  id: string;
  team_id: string;
  plan: PlanId;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_start: string;
  current_period_end: string | null;
  created_at: string;
  updated_at: string;
}
