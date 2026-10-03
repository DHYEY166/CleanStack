import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const query = vi.fn();
const queryOne = vi.fn();
const sqsSend = vi.fn();
const generateText = vi.fn();

vi.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => query(...a),
  queryOne: (...a: unknown[]) => queryOne(...a),
}));
vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: class { send = (...a: unknown[]) => sqsSend(...a); },
  SendMessageCommand: class { constructor(public input: unknown) {} },
}));
vi.mock("ai", () => ({ generateText: (...a: unknown[]) => generateText(...a) }));
vi.mock("@/lib/ai-model", () => ({ languageModel: () => ({}) }));
vi.mock("@/lib/bedrock-meter", () => ({
  checkAiBudget: async () => ({ ok: true }),
  meterBedrockCall: async () => {},
}));

const SECRET = "w".repeat(40);
process.env.WEBHOOK_SECRET = SECRET;
const { POST } = await import("./route");

const RUN = "11111111-2222-3333-4444-555555555555";
const call = () =>
  POST(new NextRequest(`http://x/api/auto-validate/${RUN}`, {
    method: "POST",
    headers: { "x-webhook-secret": SECRET },
  }), { params: Promise.resolve({ runId: RUN }) });

describe("POST /api/auto-validate/[runId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SQS_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/1/cleanstack-jobs";
    query.mockResolvedValue([{ id: "r1", rule_type: "trim_whitespace", column_name: "name", ai_reasoning: "x" }]);
    queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM data_profiles")) return { column_stats: {}, total_rows: 10 };
      if (sql.includes("p.team_id")) return { team_id: "user_1", pipeline_id: "p" };
      if (sql.includes("RETURNING id")) return { id: RUN };
      return null;
    });
    generateText.mockResolvedValue({
      text: JSON.stringify({ votes: [{ rule_id: "r1", vote: "APPROVE", reason: "ok" }] }),
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  });

  it("queues the run and enqueues it once", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(sqsSend).toHaveBeenCalledTimes(1);
    expect(queryOne.mock.calls.some((c) => String(c[0]).includes("status = 'queued'"))).toBe(true);
  });

  it("marks the run failed and returns 503 when the SQS send fails", async () => {
    sqsSend.mockRejectedValueOnce(new Error("NonExistentQueue"));
    const res = await call();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.run_status).toBe("failed");
    expect(body.error).toMatch(/Could not queue this run for execution/);
    const fail = queryOne.mock.calls.find((c) => String(c[0]).includes("SET status = 'failed'"))!;
    expect(fail[1]).toEqual([RUN, "queued", body.error]);
  });
});
