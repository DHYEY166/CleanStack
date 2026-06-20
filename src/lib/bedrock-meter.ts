import { query, queryOne } from "@/lib/db";

const PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  "us.anthropic.claude-sonnet-4-6": { inputPer1M: 3.0, outputPer1M: 15.0 },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? { inputPer1M: 3.0, outputPer1M: 15.0 };
  return (inputTokens / 1_000_000) * p.inputPer1M + (outputTokens / 1_000_000) * p.outputPer1M;
}

export async function meterBedrockCall(opts: {
  teamId: string;
  runId: string | null;
  callType: string;
  model: string;
  usage: { promptTokens?: number; completionTokens?: number; inputTokens?: number; outputTokens?: number };
}): Promise<void> {
  const { teamId, runId, callType, model, usage } = opts;
  const inputTokens = usage.promptTokens ?? usage.inputTokens ?? 0;
  const outputTokens = usage.completionTokens ?? usage.outputTokens ?? 0;
  const cost = estimateCost(model, inputTokens, outputTokens);

  // Fire-and-forget — never block the main flow
  query(
    `INSERT INTO bedrock_usage (team_id, run_id, model, call_type, input_tokens, output_tokens, estimated_cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [teamId, runId, model, callType, inputTokens, outputTokens, cost]
  ).catch((e) => console.error("[bedrock-meter] insert failed:", e));
}

export async function checkAiSpendCap(teamId: string): Promise<{
  blocked: boolean;
  warning: boolean;
  currentSpendUsd: number;
  hardCapUsd: number;
  softCapUsd: number;
}> {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [usageRow, limitsRow] = await Promise.all([
    queryOne<{ total: string }>(
      `SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total
       FROM bedrock_usage WHERE team_id = $1 AND created_at >= $2`,
      [teamId, monthStart]
    ),
    queryOne<{ soft_cap_usd: string; hard_cap_usd: string }>(
      `SELECT soft_cap_usd, hard_cap_usd FROM ai_spend_limits WHERE team_id = $1`,
      [teamId]
    ),
  ]);

  const current = Number(usageRow?.total ?? 0);
  const softCap = Number(limitsRow?.soft_cap_usd ?? 50);
  const hardCap = Number(limitsRow?.hard_cap_usd ?? 200);

  return {
    blocked: current >= hardCap,
    warning: current >= softCap && current < hardCap,
    currentSpendUsd: current,
    hardCapUsd: hardCap,
    softCapUsd: softCap,
  };
}
