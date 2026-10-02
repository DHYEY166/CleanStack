import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BEDROCK_MODEL_ID, BEDROCK_PRICING_USD_PER_1M_TOKENS, estimateBedrockCostUsd } from "@/lib/ai-config";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

describe("ai-config", () => {
  it("has a price for the configured model", () => {
    expect(BEDROCK_PRICING_USD_PER_1M_TOKENS[BEDROCK_MODEL_ID]).toEqual({ inputPer1M: 3, outputPer1M: 15 });
  });
  it("estimates cost per million tokens", () => {
    expect(estimateBedrockCostUsd(BEDROCK_MODEL_ID, 1_000_000, 0)).toBe(3);
    expect(estimateBedrockCostUsd(BEDROCK_MODEL_ID, 2_000, 1_000)).toBeCloseTo(0.006 + 0.015, 10);
  });
  it("prices unknown models like the configured one and ignores bad token counts", () => {
    expect(estimateBedrockCostUsd("some.other-model", 1_000_000, 0)).toBe(3);
    expect(estimateBedrockCostUsd(BEDROCK_MODEL_ID, NaN, -5)).toBe(0);
  });
  it("is the only place a model id is written", () => {
    const offenders = walk(join(process.cwd(), "src"))
      .filter((f) => !f.includes("ai-config"))
      .filter((f) => /anthropic\.claude/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
