/**
 * Guest quotas against real Postgres: the capped inserts for uploads and
 * pipelines, the rows-per-run check, and checkAiBudget before suggest-transforms
 * (fake model) and auto-validate. Every number comes from GUEST_LIMITS.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/auth", async () => (await import("./helpers")).authMock);

import { authState, db, env, request } from "./helpers";
import { POST as startGuest } from "@/app/api/guest/route";
import { POST as createPipeline } from "@/app/api/pipelines/route";
import { POST as upload } from "@/app/api/upload/route";
import { POST as suggestTransforms } from "@/app/api/suggest-transforms/route";
import { POST as autoValidate } from "@/app/api/auto-validate/[runId]/route";
import { GUEST_COOKIE, guestFromCookie } from "@/lib/guest";
import { GUEST_LIMITS } from "@/lib/guest-limits";
import { closePgPool } from "@/lib/db-pg";

const guests: string[] = [];
const fakeGuests: string[] = [];
afterAll(async () => {
  const all = [...guests, ...fakeGuests];
  await db.query("DELETE FROM bedrock_usage WHERE team_id = ANY($1)", [all]);
  await db.query("DELETE FROM pipelines WHERE team_id = ANY($1)", [all]);
  await db.query("DELETE FROM guest_sessions WHERE id = ANY($1)", [all]);
  await closePgPool();
  await db.end();
});

const uniqueIp = () => `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}-${randomUUID().slice(0, 6)}`;
async function newGuest(ip = uniqueIp()): Promise<string> {
  const res = await startGuest(request("/api/guest", { method: "POST", body: {}, headers: { "x-forwarded-for": ip } }));
  expect(res.status).toBe(201);
  const id = (await guestFromCookie(res.cookies.get(GUEST_COOKIE)!.value))!.guestId;
  guests.push(id);
  return id;
}
async function pipelineFor(guest: string): Promise<string> {
  authState.userId = guest;
  const res = await createPipeline(request("/api/pipelines", { method: "POST", body: { name: "g" } }));
  expect(res.status).toBe(201);
  return (await res.json()).pipeline.id;
}
const startUpload = (pipelineId: string) =>
  upload(request("/api/upload", { method: "POST", body: { pipeline_id: pipelineId, filename: "a.csv", size: 100 } }));

/** A guest run at awaiting_ai with a raw profile, as the profiler leaves it. */
async function awaitingAiRun(guest: string, rows: number, opts: { auto?: boolean } = {}): Promise<string> {
  const pipelineId = await pipelineFor(guest);
  const runId = randomUUID();
  await db.query(
    `INSERT INTO pipeline_runs (id, pipeline_id, status, file_format, raw_s3_key, row_count_raw, auto_mode)
     VALUES ($1, $2, 'awaiting_ai', 'csv', $3, $4, $5)`,
    [runId, pipelineId, `${guest}/${pipelineId}/${runId}/raw.csv`, rows, opts.auto ?? false]
  );
  await db.query(
    `INSERT INTO data_profiles (run_id, stage, quality_score, total_rows, null_percentage, duplicate_percentage, column_stats)
     VALUES ($1, 'raw', 80, $2, 0, 0, $3)`,
    [runId, rows, JSON.stringify({ amount: { dtype: "object", null_count: 0, unique_count: 3, sample_values: ["$1", "$2"] } })]
  );
  return runId;
}
const suggest = (runId: string) => suggestTransforms(request("/api/suggest-transforms", {
  method: "POST", body: { run_id: runId }, headers: { "x-webhook-secret": env("WEBHOOK_SECRET") },
}));
const usage = async (guest: string) =>
  Number((await db.query("SELECT count(*) AS n FROM bedrock_usage WHERE team_id = $1", [guest])).rows[0].n);
const run = async (id: string) => (await db.query("SELECT status, error_message FROM pipeline_runs WHERE id = $1", [id])).rows[0];
async function spend(teamId: string, calls: number, usd: number) {
  for (let i = 0; i < calls; i++) {
    await db.query("INSERT INTO bedrock_usage (team_id, model, call_type, estimated_cost_usd) VALUES ($1, 'm', 'seed', $2)", [teamId, usd / calls]);
  }
}

describe("guest upload and pipeline caps", () => {
  it(`allows ${GUEST_LIMITS.uploadsPerGuest} uploads per guest, then 429`, async () => {
    const guest = await newGuest();
    const p = await pipelineFor(guest);
    for (let i = 0; i < GUEST_LIMITS.uploadsPerGuest; i++) expect((await startUpload(p)).status).toBe(200);
    const res = await startUpload(p);
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("Guests can upload 3 files. Sign up to keep going.");
  });

  it(`allows ${GUEST_LIMITS.uploadsPerIpPerDay} uploads per IP across guests, then 429`, async () => {
    const ip = uniqueIp();
    let ok = 0;
    for (let g = 0; g < 4; g++) {
      const p = await pipelineFor(await newGuest(ip));
      for (let i = 0; i < GUEST_LIMITS.uploadsPerGuest && ok < GUEST_LIMITS.uploadsPerIpPerDay; i++) {
        expect((await startUpload(p)).status).toBe(200);
        ok++;
      }
      if (ok === GUEST_LIMITS.uploadsPerIpPerDay) {
        const res = await startUpload(p);
        expect(res.status).toBe(429);
        expect((await res.json()).error).toMatch(/for your network reached \(10 per day\)/);
      }
    }
    expect(ok).toBe(10);
  });

  it("an expired guest session cannot upload even with a valid cookie", async () => {
    const guest = await newGuest();
    const p = await pipelineFor(guest);
    await db.query("UPDATE guest_sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [guest]);
    const res = await startUpload(p);
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/expired/);
  });

  it(`caps pipelines at ${GUEST_LIMITS.pipelinesPerGuest}`, async () => {
    const guest = await newGuest();
    for (let i = 0; i < GUEST_LIMITS.pipelinesPerGuest; i++) await pipelineFor(guest);
    const res = await createPipeline(request("/api/pipelines", { method: "POST", body: { name: "one too many" } }));
    expect(res.status).toBe(429);
  });
});

describe("guest rows and AI budget before suggest-transforms", () => {
  it("a guest run under the limits gets AI rules and is metered", async () => {
    const guest = await newGuest();
    const runId = await awaitingAiRun(guest, 4);
    const res = await suggest(runId);
    expect(res.status).toBe(200);
    expect((await run(runId)).status).toBe("awaiting_approval");
    expect(await usage(guest)).toBe(1); // meterBedrockCall is awaited, so the next check sees it
  });

  it(`fails a run over ${GUEST_LIMITS.rowsPerRun} rows before any AI call`, async () => {
    const guest = await newGuest();
    const runId = await awaitingAiRun(guest, GUEST_LIMITS.rowsPerRun + 1);
    expect((await suggest(runId)).status).toBe(402);
    expect(await run(runId)).toEqual({ status: "failed", error_message: "Guest runs are limited to 5,000 rows; this file has 5,001. Sign up to clean larger files." });
    expect(await usage(guest)).toBe(0);
  });

  it(`stops at ${GUEST_LIMITS.rowsPerGuest} rows per guest, and oversized runs do not count`, async () => {
    const guest = await newGuest();
    await awaitingAiRun(guest, 50_000); // refused for size: not counted
    const first = await awaitingAiRun(guest, 5000);
    expect((await suggest(first)).status).toBe(200);
    const second = await awaitingAiRun(guest, 5000);
    // used = 10,000 including this run's rows (the profiler already recorded them)
    expect((await suggest(second)).status).toBe(402);
    expect((await run(second)).error_message).toBe("Guest row limit reached (10,000 / 10,000 rows). Sign up to keep going.");
  });

  it(`refuses the call after ${GUEST_LIMITS.aiCallsPerHour} AI calls in an hour`, async () => {
    const guest = await newGuest();
    await spend(guest, GUEST_LIMITS.aiCallsPerHour, 0.01);
    const runId = await awaitingAiRun(guest, 4);
    expect((await suggest(runId)).status).toBe(429);
    expect((await run(runId)).error_message).toBe("Guests can make 10 AI calls per hour. Try again later or sign up.");
    expect(await usage(guest)).toBe(GUEST_LIMITS.aiCallsPerHour);
  });

  it(`refuses at $${GUEST_LIMITS.aiSpendPerGuestUsd} spent by the guest`, async () => {
    const guest = await newGuest();
    await spend(guest, 1, GUEST_LIMITS.aiSpendPerGuestUsd);
    const runId = await awaitingAiRun(guest, 4);
    expect((await suggest(runId)).status).toBe(402);
    expect((await run(runId)).error_message).toBe("This guest session has used its AI allowance. Sign up to continue.");
  });

  it(`refuses every guest once all guests spent $${GUEST_LIMITS.aiSpendAllGuestsPerDayUsd} today, but not users`, async () => {
    const other = `guest_${randomUUID().replace(/-/g, "").slice(0, 22)}`;
    fakeGuests.push(other);
    await spend(other, 1, GUEST_LIMITS.aiSpendAllGuestsPerDayUsd);
    try {
      const guest = await newGuest();
      const runId = await awaitingAiRun(guest, 4);
      expect((await suggest(runId)).status).toBe(429);
      expect((await run(runId)).error_message).toMatch(/Guest AI capacity is used up for today/);
    } finally {
      await db.query("DELETE FROM bedrock_usage WHERE team_id = $1", [other]);
    }
  });

  it("auto-validate checks the budget for its 3 calls and falls back to manual review", async () => {
    const guest = await newGuest();
    const runId = await awaitingAiRun(guest, 4, { auto: true });
    await db.query("UPDATE pipeline_runs SET status = 'queued' WHERE id = $1", [runId]);
    await db.query(
      "INSERT INTO transform_rules (pipeline_id, run_id, rule_type, column_name, parameters, status, order_index) SELECT pipeline_id, id, 'trim_whitespace', 'amount', '{}', 'pending', 0 FROM pipeline_runs WHERE id = $1",
      [runId]
    );
    await spend(guest, GUEST_LIMITS.aiCallsPerHour - 2, 0.001); // 8 used: 3 more would exceed 10
    const res = await autoValidate(
      request(`/api/auto-validate/${runId}`, { method: "POST", headers: { "x-webhook-secret": env("WEBHOOK_SECRET") } }),
      { params: Promise.resolve({ runId }) }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, fallback: "manual_review", scope: "guest_hourly" });
    expect((await run(runId)).status).toBe("awaiting_approval");
    expect(await usage(guest)).toBe(GUEST_LIMITS.aiCallsPerHour - 2);
  });
});
