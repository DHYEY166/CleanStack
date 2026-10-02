/**
 * /api/approve-rules atomic claim under real Postgres row locks: of N
 * simultaneous approvals exactly one wins (200), the rest get 409, and exactly
 * one executor message reaches SQS.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/auth", async () => (await import("./helpers")).authMock);

import { authState, db, env, newUser, purgeQueue, receive, request } from "./helpers";
import { POST as approveRules } from "@/app/api/approve-rules/route";
import { closePgPool } from "@/lib/db-pg";

const pipelines: string[] = [];
beforeAll(() => purgeQueue(env("SQS_QUEUE_URL")));
afterAll(async () => {
  await db.query("DELETE FROM pipelines WHERE id = ANY($1::uuid[])", [pipelines]);
  await closePgPool();
  await db.end();
});

async function seedAwaitingApproval(user: string) {
  const pipelineId = randomUUID(), runId = randomUUID();
  pipelines.push(pipelineId);
  await db.query("INSERT INTO pipelines (id, name, owner_id, team_id) VALUES ($1, 'claim', $2, $2)", [pipelineId, user]);
  await db.query("INSERT INTO pipeline_runs (id, pipeline_id, status, raw_s3_key) VALUES ($1, $2, 'awaiting_approval', $3)",
    [runId, pipelineId, `${user}/${pipelineId}/${runId}/raw.csv`]);
  const ruleIds: string[] = [];
  for (const [i, t] of ["trim_whitespace", "deduplicate", "drop_nulls"].entries()) {
    const { rows } = await db.query(
      "INSERT INTO transform_rules (pipeline_id, run_id, rule_type, parameters, status, order_index) VALUES ($1, $2, $3, '{}', 'pending', $4) RETURNING id",
      [pipelineId, runId, t, i]);
    ruleIds.push(rows[0].id);
  }
  return { runId, ruleIds };
}

describe("approve-rules claim", () => {
  it("lets exactly one of 8 concurrent approvals through and enqueues once", async () => {
    const user = newUser();
    authState.userId = user;
    const { runId, ruleIds } = await seedAwaitingApproval(user);
    const decisions = (action: string) => ruleIds.map((rule_id, i) => ({ rule_id, action: i === 2 ? "rejected" : action, modifications: null }));

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => approveRules(request("/api/approve-rules", { method: "POST", body: { run_id: runId, rule_decisions: decisions("approved") } }))));
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409, 409, 409, 409, 409]);

    const messages = await receive(env("SQS_QUEUE_URL"), (m) => JSON.parse(m.Body!).run_id === runId, 1, 3);
    expect(messages).toHaveLength(1);

    const run = await db.query("SELECT status FROM pipeline_runs WHERE id = $1", [runId]);
    expect(run.rows[0].status).toBe("queued");
    const reviews = await db.query("SELECT count(*)::int AS n FROM approval_reviews WHERE run_id = $1", [runId]);
    expect(reviews.rows[0].n).toBe(1);
    const rules = await db.query("SELECT status FROM transform_rules WHERE run_id = $1 ORDER BY order_index", [runId]);
    expect(rules.rows.map((r) => r.status)).toEqual(["approved", "approved", "rejected"]);
  });

  it("a later approval of an already-claimed run is a 409 and enqueues nothing", async () => {
    const user = newUser();
    authState.userId = user;
    const { runId, ruleIds } = await seedAwaitingApproval(user);
    const body = { run_id: runId, rule_decisions: ruleIds.map((rule_id) => ({ rule_id, action: "approved", modifications: null })) };
    expect((await approveRules(request("/api/approve-rules", { method: "POST", body }))).status).toBe(200);
    expect((await approveRules(request("/api/approve-rules", { method: "POST", body }))).status).toBe(409);
    expect(await receive(env("SQS_QUEUE_URL"), (m) => JSON.parse(m.Body!).run_id === runId, 1, 3)).toHaveLength(1);
  });

  it("another team cannot approve the run", async () => {
    const owner = newUser();
    const { runId, ruleIds } = await seedAwaitingApproval(owner);
    authState.userId = newUser();
    const body = { run_id: runId, rule_decisions: ruleIds.map((rule_id) => ({ rule_id, action: "approved", modifications: null })) };
    expect((await approveRules(request("/api/approve-rules", { method: "POST", body }))).status).toBe(404);
    expect((await db.query("SELECT status FROM pipeline_runs WHERE id = $1", [runId])).rows[0].status).toBe("awaiting_approval");
  });
});
