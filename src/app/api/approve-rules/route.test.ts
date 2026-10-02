import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const auth = vi.fn();
const query = vi.fn();
const queryOne = vi.fn();
const queryOneWithTeam = vi.fn();
const sqsSend = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: () => auth() }));
vi.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => query(...a),
  queryOne: (...a: unknown[]) => queryOne(...a),
  queryOneWithTeam: (...a: unknown[]) => queryOneWithTeam(...a),
  withTransaction: async (fn: (tx: string) => unknown) => fn("tx"),
}));
vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: class { send = (...a: unknown[]) => sqsSend(...a); },
  SendMessageCommand: class { constructor(public input: unknown) {} },
}));

const { POST } = await import("./route");
const post = (body: unknown) =>
  POST(new NextRequest("http://x/api/approve-rules", { method: "POST", body: JSON.stringify(body) }));
const RUN = "11111111-2222-3333-4444-555555555555";
const decisions = [{ rule_id: "r1", action: "approved", modifications: null }];

describe("POST /api/approve-rules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SQS_QUEUE_URL = "https://sqs/queue";
    auth.mockResolvedValue({ userId: "user_1" });
    queryOneWithTeam.mockResolvedValue({ id: RUN, pipeline_id: "p", status: "awaiting_approval" });
    query.mockResolvedValue([]);
  });

  it("claims the run with a conditional UPDATE and enqueues exactly once", async () => {
    queryOne.mockImplementation(async (sql: string) =>
      sql.includes("WHERE id = $1 AND status = 'awaiting_approval'") ? { id: RUN } : null);
    const res = await post({ run_id: RUN, rule_decisions: decisions });
    expect(res.status).toBe(200);
    const claim = queryOne.mock.calls.find((c) => String(c[0]).includes("RETURNING id"))!;
    expect(claim[1]).toEqual([RUN, "queued"]);
    expect(sqsSend).toHaveBeenCalledTimes(1);
  });

  it("returns 409 and does not enqueue when a concurrent approval already claimed the run", async () => {
    queryOne.mockResolvedValue(null); // conditional UPDATE matched no row
    const res = await post({ run_id: RUN, rule_decisions: decisions });
    expect(res.status).toBe(409);
    expect(sqsSend).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled(); // no rule updates applied
  });

  it("completes without enqueueing when every rule is rejected", async () => {
    queryOne.mockResolvedValue({ id: RUN });
    const res = await post({ run_id: RUN, rule_decisions: [{ rule_id: "r1", action: "rejected", modifications: null }] });
    expect(res.status).toBe(200);
    const claim = queryOne.mock.calls.find((c) => String(c[0]).includes("RETURNING id"))!;
    expect(claim[1]).toEqual([RUN, "completed"]);
    expect(sqsSend).not.toHaveBeenCalled();
  });

  it("validates decisions", async () => {
    expect((await post({ run_id: RUN, rule_decisions: [{ rule_id: 1, action: "maybe" }] })).status).toBe(400);
  });
});
