import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const query = vi.fn();
const queryOne = vi.fn();
const generateText = vi.fn();

vi.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => query(...a),
  queryOne: (...a: unknown[]) => queryOne(...a),
}));
vi.mock("ai", () => ({
  generateText: (...a: unknown[]) => generateText(...a),
  Output: { object: (o: unknown) => o },
}));
vi.mock("@/lib/ai-model", () => ({ languageModel: () => ({}) }));
vi.mock("@/lib/bedrock-meter", () => ({
  checkAiBudget: async () => ({ ok: true }),
  meterBedrockCall: async () => {},
}));
vi.mock("@/lib/rate-limit", () => ({ aiLimiter: {}, checkRateLimit: async () => null }));
vi.mock("@/lib/billing", () => ({ checkQuota: async () => ({ blocked: false }), quotaBlockedMessage: () => "" }));
vi.mock("@/lib/auth", () => ({ userEmailById: async () => "a@b.c" }));

const SECRET = "s".repeat(40);
process.env.WEBHOOK_SECRET = SECRET;
const { POST } = await import("./route");

const RUN = "11111111-2222-3333-4444-555555555555";
const call = () =>
  POST(new NextRequest("http://x/api/suggest-transforms", {
    method: "POST",
    headers: { "x-webhook-secret": SECRET, "content-type": "application/json" },
    body: JSON.stringify({ run_id: RUN }),
  }));

const inserted = () =>
  queryOne.mock.calls
    .filter((c) => String(c[0]).includes("INSERT INTO transform_rules"))
    .map((c) => ({ rule_type: c[1][2], column_name: c[1][3], parameters: JSON.parse(c[1][4]) }));

describe("POST /api/suggest-transforms: bad-cell guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM pipeline_runs pr")) {
        return { id: RUN, pipeline_id: "p", team_id: "user_1", mode: "tabular", template_id: null, iteration: 1, auto_mode: false };
      }
      if (sql.includes("RETURNING id")) return { id: RUN };
      if (sql.includes("SELECT team_id FROM pipelines")) return { team_id: "user_1" };
      if (sql.includes("FROM data_profiles")) {
        return {
          total_rows: 10,
          column_stats: {
            score: { type: "object", null_count: 0, unique_count: 9, sample_values: [10, 20, "."], min: 10, max: 90, sentinel_examples: ["."] },
            status: { type: "object", null_count: 0, unique_count: 2, sample_values: ["active", "deleted"] },
          },
        };
      }
      return null;
    });
    generateText.mockResolvedValue({
      output: { rules: [
        { rule_type: "filter", column_name: "score", parameters: { operator: "neq", value: "." }, ai_reasoning: "x" },
        { rule_type: "filter", column_name: "status", parameters: { operator: "neq", value: "deleted" }, ai_reasoning: "y" },
      ] },
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  });

  it("flags a filter that removes rows for one placeholder cell and leaves a legitimate filter alone", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const [placeholder, legit] = inserted();
    expect(placeholder.parameters._guard.values).toEqual(["."]);
    expect(placeholder.parameters._guard.alternative.parameters).toEqual({ target_type: "float", null_values: ["."] });
    expect(placeholder.parameters.operator).toBe("neq"); // the rule itself is unchanged
    expect(legit.parameters).toEqual({ operator: "neq", value: "deleted" });
  });
});
