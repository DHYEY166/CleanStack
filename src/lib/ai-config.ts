/**
 * Single source of truth for the Bedrock model the app calls and the prices
 * used to meter it (bedrock_usage.estimated_cost_usd, AI spend caps).
 *
 * Changing models: update BEDROCK_MODEL_ID and add its row to
 * BEDROCK_PRICING_USD_PER_1M_TOKENS in the same commit, using the on-demand
 * prices from the AWS Bedrock pricing page for the region you deploy to.
 * The prices below are the ones the app already metered with; they are
 * estimates for spend caps, not billing.
 */

/** Cross-region inference profile for Claude Sonnet 4.6. */
export const BEDROCK_MODEL_ID = "us.anthropic.claude-sonnet-4-6";

export interface TokenPrice {
  inputPer1M: number;
  outputPer1M: number;
}

export const BEDROCK_PRICING_USD_PER_1M_TOKENS: Readonly<Record<string, TokenPrice>> = {
  [BEDROCK_MODEL_ID]: { inputPer1M: 3.0, outputPer1M: 15.0 },
};

/**
 * Estimated USD cost of one call. Unknown models are priced like the
 * configured model rather than as free, so a model swap without a pricing
 * row cannot silently disable the spend cap.
 */
export function estimateBedrockCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = BEDROCK_PRICING_USD_PER_1M_TOKENS[model] ?? BEDROCK_PRICING_USD_PER_1M_TOKENS[BEDROCK_MODEL_ID];
  const safe = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  return (safe(inputTokens) / 1_000_000) * p.inputPer1M + (safe(outputTokens) / 1_000_000) * p.outputPer1M;
}
