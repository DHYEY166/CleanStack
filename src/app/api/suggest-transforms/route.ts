import { NextRequest, NextResponse } from "next/server";
import { generateText, Output } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { queryOne, query } from "@/lib/db";
import type { DataProfile, PipelineRun } from "@/lib/types";

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

  const run = await queryOne<PipelineRun>(
    "SELECT * FROM pipeline_runs WHERE id = $1",
    [run_id]
  );
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

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

  const prompt = `You are a data quality expert. Analyze this data profile and suggest ordered transform rules to improve data quality.

Profile:
${JSON.stringify(profileSummary, null, 2)}

Sample rows (first ${sampleRows.length}):
${JSON.stringify(sampleRows, null, 2)}

Output 5-8 transform rules ordered by impact. For each rule specify:
- rule_type: one of drop_nulls, deduplicate, type_cast, rename, filter, normalize, fill_nulls, trim_whitespace
- column_name: the target column (null for table-level rules like deduplicate)
- parameters: rule-specific config (e.g. {"threshold": 0.5} for drop_nulls, {"target_type": "float"} for type_cast)
- ai_reasoning: one sentence explaining why this rule will improve quality

Focus on the highest-impact issues first (high null%, type mismatches, obvious outliers).`;

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
