import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const queryOne = vi.fn();
const sqsSend = vi.fn();

vi.mock("@/lib/db", () => ({ queryOne: (...a: unknown[]) => queryOne(...a) }));
vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: class { send = (...a: unknown[]) => sqsSend(...a); },
  SendMessageCommand: class { constructor(public input: unknown) {} },
}));

const SECRET = "w".repeat(40);
process.env.WEBHOOK_SECRET = SECRET;
process.env.AI_QUEUE_ENABLED = "true"; // read at module load
process.env.AI_JOBS_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/1/ai-jobs";
const { POST } = await import("./route");

const RUN = "11111111-2222-3333-4444-555555555555";
const post = () =>
  POST(new NextRequest("http://x/api/webhooks/profile-complete", {
    method: "POST",
    headers: { "x-webhook-secret": SECRET },
    body: JSON.stringify({ run_id: RUN }),
  }));

describe("POST /api/webhooks/profile-complete (AI queue enabled)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryOne.mockImplementation(async (sql: string) =>
      sql.startsWith("SELECT")
        ? { id: RUN, pipeline_id: "p", raw_s3_key: `user_1/p/${RUN}/raw.csv`, status: "profiling" }
        : sql.includes("RETURNING id") ? { id: RUN } : null);
  });

  it("enqueues the AI job", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, queued: true });
    expect(sqsSend).toHaveBeenCalledTimes(1);
    expect(queryOne.mock.calls.some((c) => String(c[0]).includes("'failed'"))).toBe(false);
  });

  it("marks the run failed and returns 503 when the SQS send fails", async () => {
    sqsSend.mockRejectedValueOnce(new Error("AccessDenied"));
    const res = await post();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ run_status: "failed" });
    expect(body.error).toMatch(/Could not queue this run for AI suggestions/);
    const fail = queryOne.mock.calls.find((c) => String(c[0]).includes("SET status = 'failed'"))!;
    expect(fail[1]).toEqual([RUN, "awaiting_ai", body.error]);
  });
});
