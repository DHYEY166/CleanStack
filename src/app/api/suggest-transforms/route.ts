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

  const prompt = `You are a senior data engineer reviewing a dataset for quality issues. Analyze the profile and sample rows below, then output a prioritized list of transform rules to clean the data.

## Data Profile
${JSON.stringify(profileSummary, null, 2)}

## Sample Rows (up to ${sampleRows.length} rows)
${JSON.stringify(sampleRows, null, 2)}

## Detection Checklist — check EVERY column against ALL of these:

1. **Currency/number strings**: Does a column contain values like "$1,234.56", "€50", "1.5e3", "1,000"? → type_cast with target_type "float", parameters: {"target_type": "float"}
2. **Mixed date formats**: Does a column have dates in multiple formats ("2024-01-15", "01/15/2024", "Jan 15 2024", "15-01-2024")? → normalize, parameters: {}
3. **Null/missing values**: Any column with null_pct > 0? If numeric → fill_nulls with strategy "mean" or "median". If categorical → fill_nulls with strategy "value" and a sensible default.
4. **String "nan" / "none" / "null" / "N/A"**: Sample values showing literal strings "nan", "none", "null", "N/A", "" that represent missing data? → filter with operator "notnull" OR trim_whitespace first
5. **Duplicate rows**: duplicate_percentage > 0? → deduplicate (column_name: null)
6. **Mixed case**: A categorical column with values like "ACTIVE", "active", "Active" mixed together? → normalize to make consistent (lowercases)
7. **Leading/trailing whitespace**: Sample values with extra spaces? → trim_whitespace
8. **Percentage strings**: Values like "28%", "0.28"? → type_cast to float, parameters: {"target_type": "float"}
9. **Boolean strings**: Values like "true"/"false", "TRUE"/"FALSE", "yes"/"no"? → normalize
10. **Outliers**: Numeric columns with obvious bad values (negative IDs, ratings < 0 or > 5, duration_ms = 99999)? → filter with appropriate operator/value

## Rules
- Output 6–10 rules, ordered highest impact first
- One rule per column per issue (don't stack same rule twice on same column)
- For fill_nulls on numeric columns use strategy "mean"; for categorical use strategy "value" with fill value that makes sense (e.g., "Unknown", "Uncategorized", 0)
- For type_cast on currency columns: target_type must be "float"
- Always include deduplicate if duplicate_percentage > 0
- Always include trim_whitespace if any column has leading/trailing spaces in sample values

## Parameters reference
- drop_nulls: {"threshold": 0.0–1.0}  (fraction of non-null required; 0 = drop if any null)
- deduplicate: {}
- type_cast: {"target_type": "float"|"int"|"str"|"datetime"}
- normalize: {} (for dates and case normalization)
- fill_nulls: {"strategy": "mean"|"median"|"mode"|"value", "value": "fallback string or 0"}
- trim_whitespace: {}
- filter: {"operator": "notnull"|"eq"|"neq"|"gt"|"lt", "value": "..."}
- rename: {"new_name": "snake_case_name"}

For each rule provide a concise ai_reasoning (1 sentence, explain the specific values seen that triggered it).`;

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
