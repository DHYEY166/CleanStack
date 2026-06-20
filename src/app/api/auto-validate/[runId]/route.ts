import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { bedrock } from "@ai-sdk/amazon-bedrock";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { query, queryOne } from "@/lib/db";
import { meterBedrockCall } from "@/lib/bedrock-meter";
import type { TransformRule, DataProfile } from "@/lib/types";

export const maxDuration = 120;

const sqs = new SQSClient({ region: process.env.AWS_REGION ?? "us-east-1" });

// Risk tiers — votes needed to approve
const RISK_THRESHOLDS: Record<string, number> = {
  // LOW — 1 of 3
  trim_whitespace: 1,
  fill_nulls: 1,
  normalize: 1,
  rename: 1,
  fix_encoding: 1,
  normalize_whitespace: 1,
  remove_blank_lines: 1,
  strip_html: 1,
  // MEDIUM — 2 of 3
  type_cast: 2,
  deduplicate: 2,
  semantic_deduplicate: 2,
  ner_redact: 2,
  strip_pii: 2,
  redact_pattern: 2,
  // HIGH — 3 of 3 (unanimous)
  drop_nulls: 3,
  filter: 3,
  remove_headers_footers: 3,
};

interface VoteResult {
  rule_id: string;
  vote: "APPROVE" | "REJECT";
  reason: string;
}

function parseVotes(text: string, rules: TransformRule[]): VoteResult[] {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    if (Array.isArray(parsed.votes)) return parsed.votes;
  } catch {
    // fallback: try to extract per-rule votes from text
  }
  // Fallback: approve all if parse fails
  return rules.map((r) => ({ rule_id: r.id, vote: "APPROVE" as const, reason: "parse fallback" }));
}

async function runConsultant(
  persona: string,
  systemPrompt: string,
  userPrompt: string,
  rules: TransformRule[]
): Promise<{ votes: VoteResult[]; usage: { promptTokens: number; completionTokens: number } }> {
  try {
    const result = await generateText({
      model: bedrock("us.anthropic.claude-sonnet-4-6"),
      system: systemPrompt,
      prompt: userPrompt,
      maxOutputTokens: 1500,
    });
    return { votes: parseVotes(result.text, rules), usage: result.usage };
  } catch (e) {
    console.error(`[auto-validate] ${persona} failed:`, e);
    // On error, approve all LOW risk, reject HIGH risk (conservative fallback)
    return { votes: rules.map((r) => ({
      rule_id: r.id,
      vote: (RISK_THRESHOLDS[r.rule_type] ?? 2) <= 1 ? "APPROVE" : "REJECT" as const,
      reason: `${persona} unavailable`,
    })), usage: { promptTokens: 0, completionTokens: 0 } };
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const secret = req.headers.get("x-webhook-secret");
  if (secret !== process.env.WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { runId } = await params;

  const rules = await query<TransformRule>(
    "SELECT * FROM transform_rules WHERE run_id = $1 AND status = 'pending' ORDER BY order_index ASC",
    [runId]
  );
  if (!rules.length) {
    await queryOne("UPDATE pipeline_runs SET status = 'completed' WHERE id = $1", [runId]);
    return NextResponse.json({ ok: true, approved: 0, rejected: 0 });
  }

  const rawProfile = await queryOne<DataProfile>(
    "SELECT * FROM data_profiles WHERE run_id = $1 AND stage = 'raw'",
    [runId]
  );

  const colStats = rawProfile?.column_stats ?? {};
  const totalRows = rawProfile?.total_rows ?? 0;
  const nullPct = Number(rawProfile?.null_percentage ?? 0);
  const dupPct = Number(rawProfile?.duplicate_percentage ?? 0);

  // Build rule list string for prompts
  const ruleList = rules.map((r, i) =>
    `${i + 1}. rule_id="${r.id}" rule_type="${r.rule_type}" column="${r.column_name ?? "ALL"}" reasoning="${r.ai_reasoning ?? ""}"`
  ).join("\n");

  // Safety Auditor — sees row/null/dup numbers only
  const auditorData = rules.map((r) => {
    const s = r.column_name ? (colStats[r.column_name] as unknown as Record<string, unknown> | undefined) : null;
    const nullCount = s ? (s.null_count as number ?? 0) : 0;
    const affectedRows = r.rule_type === "drop_nulls" ? nullCount
      : r.rule_type === "filter" ? Math.round(totalRows * 0.3)
      : Math.round(totalRows * 0.05);
    return `rule_id="${r.id}" type="${r.rule_type}" col="${r.column_name ?? "ALL"}" null_count=${nullCount} affected_rows≈${affectedRows}`;
  }).join("\n");

  // Statistician — sees distribution stats only
  const statData = rules.map((r) => {
    const s = r.column_name ? (colStats[r.column_name] as unknown as Record<string, unknown> | undefined) : null;
    return `rule_id="${r.id}" type="${r.rule_type}" col="${r.column_name ?? "ALL"}" unique=${s?.unique_count ?? "?"} outliers=${rawProfile?.outlier_count ?? 0} sentinel_pct=${(s as Record<string, unknown> | undefined)?.sentinel_pct ?? 0}`;
  }).join("\n");

  // Domain Validator — sees column names, samples, reasoning
  const domainData = rules.map((r) => {
    const s = r.column_name ? (colStats[r.column_name] as unknown as Record<string, unknown> | undefined) : null;
    const samples = Array.isArray(s?.sample_values) ? (s!.sample_values as unknown[]).slice(0, 3).join(", ") : "N/A";
    return `rule_id="${r.id}" type="${r.rule_type}" col="${r.column_name ?? "ALL"}" samples=[${samples}] reasoning="${r.ai_reasoning ?? ""}"`;
  }).join("\n");

  const responseFormat = `Respond ONLY with valid JSON in this exact format:
{"votes":[{"rule_id":"<id>","vote":"APPROVE","reason":"<one sentence>"},{"rule_id":"<id>","vote":"REJECT","reason":"<one sentence>"}]}
Include a vote for every rule_id listed. No extra text.`;

  // Fetch team_id for metering
  const pipelineRow = await queryOne<{ team_id: string; pipeline_id: string }>(
    "SELECT p.team_id, pr.pipeline_id FROM pipeline_runs pr JOIN pipelines p ON pr.pipeline_id = p.id WHERE pr.id = $1",
    [runId]
  );

  const [auditorResult, statResult, domainResult] = await Promise.all([
    runConsultant(
      "SafetyAuditor",
      `You are a Data Safety Auditor. Your job: review proposed data cleaning rules for a dataset that has ALREADY been partially cleaned in a previous pass. Be strict about rules that delete or drop rows — require strong justification. Approve safe transformations freely.
Dataset: ${totalRows} total rows, ${nullPct.toFixed(1)}% nulls overall, ${dupPct.toFixed(1)}% duplicates.
${responseFormat}`,
      `Rules to review (data loss perspective):\n${auditorData}\n\nFull rule list:\n${ruleList}`,
      rules
    ),
    runConsultant(
      "Statistician",
      `You are a Statistical Analyst. Review proposed cleaning rules based purely on statistical justification. A rule is justified if the numbers support it (high null %, significant outliers, clear duplicates). Approve if statistically sound, reject if the data doesn't support the intervention.
${responseFormat}`,
      `Rules to review (statistical perspective):\n${statData}\n\nFull rule list:\n${ruleList}`,
      rules
    ),
    runConsultant(
      "DomainValidator",
      `You are a Domain Expert in data quality. Review proposed cleaning rules for semantic correctness. Does the rule make sense for this type of column and data? Approve if the rule matches the data's domain and purpose, reject if it seems arbitrary or could corrupt meaningful data.
${responseFormat}`,
      `Rules to review (domain/semantic perspective):\n${domainData}\n\nFull rule list:\n${ruleList}`,
      rules
    ),
  ]);

  // Meter all 3 Bedrock calls
  if (pipelineRow?.team_id) {
    const MODEL = "us.anthropic.claude-sonnet-4-6";
    [
      { r: auditorResult, type: "auto_validate_auditor" },
      { r: statResult, type: "auto_validate_stat" },
      { r: domainResult, type: "auto_validate_domain" },
    ].forEach(({ r, type }) =>
      meterBedrockCall({ teamId: pipelineRow.team_id, runId, callType: type, model: MODEL, usage: r.usage })
    );
  }

  const [auditorVotes, statVotes, domainVotes] = [auditorResult.votes, statResult.votes, domainResult.votes];

  // Tally votes per rule
  const approved: string[] = [];
  const rejected: Array<{ id: string; reasons: string[] }> = [];

  for (const rule of rules) {
    const threshold = RISK_THRESHOLDS[rule.rule_type] ?? 2;
    const allVotes = [auditorVotes, statVotes, domainVotes];
    const approveCount = allVotes.filter(
      (votes) => votes.find((v) => v.rule_id === rule.id)?.vote === "APPROVE"
    ).length;

    const rejectReasons = allVotes
      .map((votes) => votes.find((v) => v.rule_id === rule.id))
      .filter((v) => v?.vote === "REJECT")
      .map((v) => v!.reason);

    if (approveCount >= threshold) {
      approved.push(rule.id);
    } else {
      rejected.push({ id: rule.id, reasons: rejectReasons });
    }
  }

  // Update rule statuses + store rejection reasons
  await Promise.all([
    ...approved.map((id) =>
      queryOne("UPDATE transform_rules SET status = 'approved' WHERE id = $1", [id])
    ),
    ...rejected.map(({ id, reasons }) =>
      queryOne(
        "UPDATE transform_rules SET status = 'rejected', parameters = parameters || $2 WHERE id = $1",
        [id, JSON.stringify({ _reject_reasons: reasons })]
      )
    ),
  ]);

  if (approved.length > 0 && process.env.SQS_QUEUE_URL) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: process.env.SQS_QUEUE_URL,
        MessageBody: JSON.stringify({ run_id: runId }),
      })
    );
    await queryOne("UPDATE pipeline_runs SET status = 'queued' WHERE id = $1", [runId]);
  } else {
    // No approved rules — mark completed, nothing to execute
    await queryOne("UPDATE pipeline_runs SET status = 'completed' WHERE id = $1", [runId]);
  }

  return NextResponse.json({
    ok: true,
    approved: approved.length,
    rejected: rejected.length,
    details: { approved, rejected },
  });
}
