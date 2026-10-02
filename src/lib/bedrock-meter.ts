import { query, queryOne } from "@/lib/db";
import { logger } from "@/lib/logger";
import { estimateBedrockCostUsd } from "@/lib/ai-config";
import { isGuestId } from "@/lib/guest";
import { GUEST_LIMITS } from "@/lib/guest-limits";

const log = logger.child({ component: "bedrock-meter" });

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
  const cost = estimateBedrockCostUsd(model, inputTokens, outputTokens);

  // Never throws (a failed insert is logged). Await it so the next budget check
  // sees this call; callers that must not wait can drop the promise.
  await query(
    `INSERT INTO bedrock_usage (team_id, run_id, model, call_type, input_tokens, output_tokens, estimated_cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [teamId, runId, model, callType, inputTokens, outputTokens, cost]
  ).catch((e) => log.error("bedrock usage insert failed", { err: e, team_id: teamId, call_type: callType }));
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

export type AiBudget =
  | { ok: true }
  | { ok: false; status: 402 | 429; error: string; scope: "team_month" | "guest_hourly" | "guest_total" | "guests_daily" };

/**
 * Checked before EVERY Bedrock call (suggest-transforms, auto-validate,
 * chat-builder, generate-data). `calls` is how many calls the caller is about
 * to make (the committee makes 3 in parallel).
 *
 * - Signed-in users: the monthly hard cap in ai_spend_limits (default $200).
 * - Guests (GUEST_LIMITS): at most aiCallsPerHour calls in the last hour,
 *   aiSpendPerGuestUsd in total, and all guests together under
 *   aiSpendAllGuestsPerDayUsd since 00:00 UTC. One query, counted from
 *   bedrock_usage, so it holds without Upstash.
 *
 * Usage is recorded after a call, so concurrent requests can overshoot by the
 * cost of the calls in flight; see README "AI spend".
 */
export async function checkAiBudget(teamId: string, calls = 1): Promise<AiBudget> {
  if (!isGuestId(teamId)) {
    const cap = await checkAiSpendCap(teamId);
    return cap.blocked
      ? { ok: false, status: 402, scope: "team_month", error: `AI spend cap reached ($${cap.currentSpendUsd.toFixed(2)} / $${cap.hardCapUsd} this month). Contact support.` }
      : { ok: true };
  }

  const row = await queryOne<{ calls_hour: string; guest_total: string; guests_today: string }>(
    `SELECT
       (SELECT count(*) FROM bedrock_usage
         WHERE team_id = $1 AND created_at > now() - interval '1 hour') AS calls_hour,
       (SELECT COALESCE(SUM(estimated_cost_usd), 0) FROM bedrock_usage
         WHERE team_id = $1) AS guest_total,
       (SELECT COALESCE(SUM(estimated_cost_usd), 0) FROM bedrock_usage
         WHERE team_id LIKE 'guest\\_%' AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS guests_today`,
    [teamId]
  );
  const callsHour = Number(row?.calls_hour ?? 0);
  const guestTotal = Number(row?.guest_total ?? 0);
  const guestsToday = Number(row?.guests_today ?? 0);

  if (guestsToday >= GUEST_LIMITS.aiSpendAllGuestsPerDayUsd) {
    log.warn("daily AI budget for all guests reached", { guests_today_usd: guestsToday });
    return { ok: false, status: 429, scope: "guests_daily", error: "Guest AI capacity is used up for today. Sign up to continue, or try again tomorrow." };
  }
  if (guestTotal >= GUEST_LIMITS.aiSpendPerGuestUsd) {
    return { ok: false, status: 402, scope: "guest_total", error: "This guest session has used its AI allowance. Sign up to continue." };
  }
  if (callsHour + calls > GUEST_LIMITS.aiCallsPerHour) {
    return { ok: false, status: 429, scope: "guest_hourly", error: `Guests can make ${GUEST_LIMITS.aiCallsPerHour} AI calls per hour. Try again later or sign up.` };
  }
  return { ok: true };
}
