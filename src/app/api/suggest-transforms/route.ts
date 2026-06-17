import { NextRequest, NextResponse } from "next/server";
import { generateText, Output } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

export const maxDuration = 60;
import { z } from "zod";
import { queryOne, query } from "@/lib/db";
import type { DataProfile, PipelineRun, PipelineTemplate, TemplateRule } from "@/lib/types";

const ruleSchema = z.object({
  rule_type: z.enum([
    "drop_nulls",
    "deduplicate",
    "type_cast",
    "rename",
    "filter",
    "normalize",
    "fill_nulls",
    "trim_whitespace",
  ]),
  column_name: z.string().nullable(),
  parameters: z.record(z.string(), z.unknown()),
  ai_reasoning: z.string(),
});

const outputSchema = z.object({
  rules: z.array(ruleSchema),
});

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-webhook-secret");
  if (secret !== process.env.WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { run_id } = await req.json();
  if (!run_id) return NextResponse.json({ error: "run_id required" }, { status: 400 });

  const run = await queryOne<PipelineRun & { template_id: string | null }>(
    `SELECT pr.*, p.template_id
     FROM pipeline_runs pr
     JOIN pipelines p ON pr.pipeline_id = p.id
     WHERE pr.id = $1`,
    [run_id]
  );
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  // Short-circuit: if pipeline was created from a template, use its rules directly
  if (run.template_id) {
    const template = await queryOne<PipelineTemplate>(
      "SELECT * FROM pipeline_templates WHERE id = $1",
      [run.template_id]
    );
    if (template?.transform_rules?.length) {
      const rules: TemplateRule[] = Array.isArray(template.transform_rules)
        ? template.transform_rules
        : (template.transform_rules as unknown as TemplateRule[]);

      await Promise.all(
        rules.map((rule, idx) =>
          queryOne(
            `INSERT INTO transform_rules
               (pipeline_id, run_id, rule_type, column_name, parameters, ai_reasoning, status, order_index)
             VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
            [
              run.pipeline_id,
              run_id,
              rule.rule_type,
              rule.column_name,
              JSON.stringify(rule.parameters),
              rule.ai_reasoning,
              idx,
            ]
          )
        )
      );

      await queryOne(
        "UPDATE pipeline_runs SET status = 'awaiting_approval' WHERE id = $1",
        [run_id]
      );

      return NextResponse.json({ ok: true, rules_count: rules.length, source: "template" });
    }
  }

  const profile = await queryOne<DataProfile>(
    "SELECT * FROM data_profiles WHERE run_id = $1 AND stage = 'raw'",
    [run_id]
  );
  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  const columnStats = profile.column_stats ?? {};
  const sampleRows = buildSampleRows(columnStats);

  const profileSummary = {
    quality_score: profile.quality_score,
    total_rows: profile.total_rows,
    null_percentage: profile.null_percentage,
    duplicate_percentage: profile.duplicate_percentage,
    type_mismatch_count: profile.type_mismatch_count,
    outlier_count: profile.outlier_count,
    columns: Object.fromEntries(
      Object.entries(columnStats).map(([col, stat]) => [
        col,
        {
          type: stat.type,
          null_pct: stat.null_pct,
          unique_count: stat.unique_count,
          sample_values: stat.sample_values?.slice(0, 5),
        },
      ])
    ),
  };

  const prompt = `You are an expert data quality engineer at a top-tier data infrastructure company. Your job is to inspect a dataset profile and sample rows, identify every data quality problem present, and produce a precise ordered list of transform rules to fix them.

You must be thorough, specific, and correct. Do not guess — only flag issues that are actually visible in the profile stats or sample values.

---

## DATASET PROFILE
${JSON.stringify(profileSummary, null, 2)}

## SAMPLE ROWS (up to ${sampleRows.length} rows — treat these as representative)
${JSON.stringify(sampleRows, null, 2)}

---

## STEP 1 — SYSTEMATIC COLUMN ANALYSIS

For every column in the profile, work through ALL of the following checks. Do not skip any column.

### A. Whitespace & Encoding
- Are any sample values wrapped in leading or trailing spaces (e.g. "  John Smith  ", " 95000")?
  → trim_whitespace on that column (or globally if multiple columns affected)
- Are there non-printable characters, tab characters, or unicode artifacts in string values?
  → trim_whitespace

### B. Null / Missing Value Detection
- null_pct > 0 on any column?
  → Decide: if a critical identifier column (id, key), use drop_nulls. If a descriptive column:
    - Numeric column → fill_nulls with strategy "mean" or "median"
    - Categorical column → fill_nulls with strategy "value" and pick a domain-appropriate default (e.g. "Unknown", "Uncategorized", "N/A", 0)
    - Date column → fill_nulls with strategy "value", value "1970-01-01"
- Sample values contain literal strings "nan", "none", "null", "NULL", "N/A", "n/a", "NA", "", "-", "?" that represent missing data?
  → These are NOT real values. Apply trim_whitespace first, then fill_nulls or filter notnull depending on severity.

### C. Duplicate Rows
- duplicate_percentage > 0?
  → Always add deduplicate (column_name: null, parameters: {})

### D. Data Type Mismatches
- type_mismatch_count > 0 indicates mixed types in a column.
- Sample values contain currency symbols ($, €, £, ¥), commas in numbers ("1,234"), or scientific notation ("1.5e3", "2.3E+04")?
  → type_cast with target_type "float"
- Sample values contain percentage signs ("28%", "0.5%")?
  → type_cast with target_type "float" (the executor strips % and divides or just strips)
- Column is named *_id, *_count, *_qty, *_quantity, *_num, *_number and values look like integers stored as floats (50.0, 200.0)?
  → type_cast with target_type "int"
- Column looks like a date/timestamp but dtype is "object"?
  → type_cast with target_type "datetime"
- Column values are "true"/"false", "True"/"False", "TRUE"/"FALSE", "yes"/"no", "1"/"0" and should be boolean?
  → normalize (will standardize to lowercase consistent form)

### E. Date / Timestamp Format Inconsistency
- Does a date-like column have values in multiple formats across the samples? E.g.:
  "2024-01-15", "01/15/2024", "Jan 15 2024", "15-01-2024", "January 15, 2024", "Jan-15-2024", "2024/01/15"
  → normalize on that column (the executor will parse mixed formats and output YYYY-MM-DD)
- Even if null_pct is 0, if date formats differ between rows → normalize

### F. Case Inconsistency in Categorical Columns
- Sample values for a categorical column show mixed casing: "ACTIVE", "active", "Active", "SHIPPED", "shipped", "Shipped"?
  → normalize on that column (executor lowercases string columns)
- Country codes mixed: "US", "us", "Us" or "UK", "uk"?
  → normalize
- Status fields, plan names, labels, tags with inconsistent casing?
  → normalize

### G. Outliers & Invalid Values
- outlier_count > 0 in the profile?
- Sample values contain obviously invalid data:
  - Negative values where only positives make sense (negative IDs, negative age, negative duration_ms like "-50", negative ratings)?
    → filter with operator "gt", value "0" (or appropriate threshold)
  - Ratings/scores outside valid range (e.g. rating = -1, rating = 99 when scale is 0–5)?
    → filter with operator "gt"/"lt" as needed
  - Sentinel/placeholder values like 99999, 9999, -9999 in numeric columns?
    → filter to exclude them
  - Future dates in a "created_at" or "signup_date" column that should be historical?
    → filter with operator "lt" and today's date

### H. String Consistency & Formatting
- Phone numbers in multiple formats ("555-0101", "(555) 0102", "555.0103", "5550109")?
  → normalize
- Email addresses with mixed case ("JOHN@EMAIL.COM", "john@email.com")?
  → normalize
- Column names themselves have spaces, mixed case, or special characters?
  → rename to snake_case

### I. Column-Level Drop Decision
- A column where null_pct > 80% and it has very low unique_count (almost always null)?
  → drop_nulls with threshold 0.2 (keep only rows where at least 20% non-null, effectively dropping the column's bad rows)
- OR if the column is entirely useless (all nulls), do not add a fill rule — add drop_nulls

---

## STEP 2 — GLOBAL RULES

After column analysis, check dataset-level issues:
- If ANY column had leading/trailing whitespace in multiple columns → add ONE global trim_whitespace with column_name null (applies to all string columns)
- If duplicate_percentage > 0 → add deduplicate with column_name null

---

## STEP 3 — ORDER YOUR RULES BY IMPACT

Use this ordering priority:
1. trim_whitespace (must run first — affects downstream detection)
2. deduplicate (remove duplicates before computing anything)
3. fill_nulls (fill before type casts so nulls don't break numeric ops)
4. type_cast (convert types after nulls are handled)
5. normalize (date/case normalization after types are set)
6. filter (remove outliers/invalid rows after cleaning)
7. rename (cosmetic, last)

---

## STEP 4 — OUTPUT RULES

Output between 6 and 12 rules. More rules = better coverage. Do NOT limit yourself to 5 if there are more real issues.

Rules must be:
- SPECIFIC: reference the exact column name and the exact issue seen in sample values
- CORRECT: only flag issues that exist in the data — do not invent problems
- COMPLETE: cover every column that has a detectable issue

## EXACT PARAMETER SCHEMAS (use these exactly):

trim_whitespace:
  column_name: null (global) or specific column name
  parameters: {}

deduplicate:
  column_name: null
  parameters: {}

drop_nulls:
  column_name: "column" or null (table-level)
  parameters: {"threshold": 0.5}   ← fraction of rows that must be non-null to keep row

fill_nulls:
  column_name: "column"
  parameters: {"strategy": "mean"}                         ← for numeric columns
  parameters: {"strategy": "median"}                       ← for numeric with outliers
  parameters: {"strategy": "mode"}                         ← for categorical with clear dominant value
  parameters: {"strategy": "value", "value": "Unknown"}    ← for categorical with no clear dominant
  parameters: {"strategy": "value", "value": "0"}          ← for numeric where 0 is sensible default

type_cast:
  column_name: "column"
  parameters: {"target_type": "float"}     ← for currency, decimals, percentages, scientific notation
  parameters: {"target_type": "int"}       ← for integer IDs, counts, quantities
  parameters: {"target_type": "str"}       ← force string type
  parameters: {"target_type": "datetime"}  ← for date/timestamp columns

normalize:
  column_name: "column"
  parameters: {}    ← executor handles both date normalization (→ YYYY-MM-DD) and string lowercasing automatically based on column dtype

filter:
  column_name: "column"
  parameters: {"operator": "notnull"}
  parameters: {"operator": "gt", "value": "0"}
  parameters: {"operator": "lt", "value": "100"}
  parameters: {"operator": "eq", "value": "active"}
  parameters: {"operator": "neq", "value": "deleted"}

rename:
  column_name: "OldName"
  parameters: {"new_name": "new_snake_case_name"}

---

For each rule, write ai_reasoning as one precise sentence that references the specific values observed (e.g. "Sample values show '$24.99', '$199.99' — currency symbols prevent numeric aggregation; stripping and casting to float enables revenue calculations.").`;

  const { output } = await generateText({
    model: anthropic("claude-sonnet-4-6"),
    output: Output.object({ schema: outputSchema }),
    prompt,
  });

  if (!output?.rules?.length) {
    await queryOne(
      "UPDATE pipeline_runs SET status = 'failed', error_message = $2 WHERE id = $1",
      [run_id, "AI returned no transform rules"]
    );
    return NextResponse.json({ error: "No rules generated" }, { status: 500 });
  }

  await Promise.all(
    output.rules.map((rule, idx) =>
      queryOne(
        `INSERT INTO transform_rules
           (pipeline_id, run_id, rule_type, column_name, parameters, ai_reasoning, status, order_index)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
        [
          run.pipeline_id,
          run_id,
          rule.rule_type,
          rule.column_name,
          JSON.stringify(rule.parameters),
          rule.ai_reasoning,
          idx,
        ]
      )
    )
  );

  await queryOne(
    "UPDATE pipeline_runs SET status = 'awaiting_approval' WHERE id = $1",
    [run_id]
  );

  return NextResponse.json({ ok: true, rules_count: output.rules.length });
}

function buildSampleRows(
  columnStats: Record<string, { sample_values?: unknown[] }>
): Record<string, unknown>[] {
  const columns = Object.keys(columnStats);
  if (!columns.length) return [];

  const maxSamples = Math.max(
    ...columns.map((c) => columnStats[c].sample_values?.length ?? 0)
  );
  const rows: Record<string, unknown>[] = [];

  for (let i = 0; i < Math.min(maxSamples, 20); i++) {
    const row: Record<string, unknown> = {};
    for (const col of columns) {
      row[col] = columnStats[col].sample_values?.[i] ?? null;
    }
    rows.push(row);
  }

  return rows;
}
