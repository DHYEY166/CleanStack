/**
 * Guest demo against real Postgres + LocalStack:
 *   sample data (server-side PutObject) -> S3 notification -> profiler ->
 *   suggest-transforms on the seeded template (no Bedrock call) -> approve ->
 *   executor -> download; then /api/cron/purge-guests erases the expired guest
 *   (every S3 version and the DB rows) but keeps its bedrock_usage rows, and
 *   leaves live guests and users alone.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/auth", async () => (await import("./helpers")).authMock);

import {
  allVersions, authState, db, env, invokeLambda, newUser, purgeQueue, putObject, receive, request, sqsRecord, startAppServer,
} from "./helpers";
import { POST as startGuest } from "@/app/api/guest/route";
import { POST as sampleData } from "@/app/api/sample-data/route";
import { POST as profileComplete } from "@/app/api/webhooks/profile-complete/route";
import { POST as suggestTransforms } from "@/app/api/suggest-transforms/route";
import { POST as approveRules } from "@/app/api/approve-rules/route";
import { GET as download } from "@/app/api/download/[runId]/route";
import { GET as purgeGuests } from "@/app/api/cron/purge-guests/route";
import { GUEST_COOKIE, guestFromCookie } from "@/lib/guest";
import { DEMO_TEMPLATE_RULES } from "@/lib/sample-data";
import { closePgPool } from "@/lib/db-pg";
import { SAMPLE_CLEAN_LINES } from "../support/sample-expected";

let app: { url: string; server: Server };
const created: string[] = [];

beforeAll(async () => {
  app = await startAppServer({
    "POST /api/webhooks/profile-complete": profileComplete,
    "POST /api/suggest-transforms": suggestTransforms,
  });
  process.env.NEXT_PUBLIC_APP_URL = app.url;
  await purgeQueue(env("RAW_EVENTS_QUEUE_URL"));
  await purgeQueue(env("SQS_QUEUE_URL"));
});
afterAll(async () => {
  await new Promise((r) => app.server.close(r));
  await db.query("DELETE FROM bedrock_usage WHERE team_id = ANY($1)", [created]);
  await db.query("DELETE FROM pipelines WHERE team_id = ANY($1)", [created]);
  await db.query("DELETE FROM guest_sessions WHERE id = ANY($1)", [created]);
  await closePgPool();
  await db.end();
});

async function newGuest(): Promise<string> {
  const res = await startGuest(request("/api/guest", { method: "POST", body: {}, headers: { "x-forwarded-for": `it-${randomUUID()}` } }));
  expect(res.status).toBe(201);
  const id = (await guestFromCookie(res.cookies.get(GUEST_COOKIE)!.value))!.guestId;
  created.push(id);
  return id;
}
const cron = () => purgeGuests(new Request("http://localhost/api/cron/purge-guests", { headers: { Authorization: `Bearer ${env("CRON_SECRET")}` } }));

describe("guest demo: sample data -> clean file -> purge", () => {
  it("cleans the sample with template rules and no AI call, then the purge erases the guest", async () => {
    const guest = await newGuest();
    authState.userId = guest;

    const res = await sampleData();
    expect(res.status).toBe(201);
    const { pipeline_id, run_id } = await res.json();
    const key = `${guest}/${pipeline_id}/${run_id}/raw.csv`;

    const [notification] = await receive(env("RAW_EVENTS_QUEUE_URL"), (m) => (m.Body ?? "").includes(run_id), 1, 0);
    expect(notification, "no S3 notification for the sample PutObject").toBeDefined();
    expect(notification.Body).toContain(encodeURIComponent(key).replace(/%2F/g, "/"));
    const profiled = await invokeLambda("profiler", JSON.parse(notification.Body!), { APP_URL: app.url });
    expect(profiled.result).toEqual({ statusCode: 200, run_id });

    const { rows: [run] } = await db.query("SELECT status, row_count_raw FROM pipeline_runs WHERE id = $1", [run_id]);
    expect(run).toEqual({ status: "awaiting_approval", row_count_raw: 14 });
    const { rows: rules } = await db.query(
      "SELECT id, rule_type, column_name FROM transform_rules WHERE run_id = $1 ORDER BY order_index", [run_id]);
    expect(rules.map((r) => [r.rule_type, r.column_name])).toEqual(DEMO_TEMPLATE_RULES.map((r) => [r.rule_type, r.column_name]));
    expect(Number((await db.query("SELECT count(*) AS n FROM bedrock_usage WHERE team_id = $1", [guest])).rows[0].n)).toBe(0);

    const aRes = await approveRules(request("/api/approve-rules", {
      method: "POST",
      body: { run_id, rule_decisions: rules.map((r) => ({ rule_id: r.id, action: "approved", modifications: null })) },
    }));
    expect(aRes.status).toBe(200);
    const messages = await receive(env("SQS_QUEUE_URL"), (m) => JSON.parse(m.Body!).run_id === run_id, 1);
    const executed = await invokeLambda("executor", { Records: messages.map(sqsRecord) });
    expect(executed.result).toEqual({ statusCode: 200, run_id });

    const dRes = await download(request(`/api/download/${run_id}`), { params: Promise.resolve({ runId: run_id }) });
    expect(dRes.status).toBe(200);
    const lines = (await (await fetch((await dRes.json()).url)).text()).trim().split("\n");
    expect(lines).toEqual(SAMPLE_CLEAN_LINES); // 14 rows, 2 duplicates removed, every rule applied

    // Purge: a live guest and a user are untouched; the expired guest is erased.
    const live = await newGuest();
    authState.userId = live;
    const liveRun = await (await sampleData()).json();
    const user = newUser();
    created.push(user);
    await db.query("INSERT INTO pipelines (name, owner_id, team_id, created_at) VALUES ('old', $1, $1, now() - interval '3 days')", [user]);

    await putObject(env("S3_RAW_BUCKET"), `${guest}/${pipeline_id}/extra/raw.csv`, "a\n1\n");
    await putObject(env("S3_RAW_BUCKET"), `${guest}/${pipeline_id}/extra/raw.csv`, "a\n2\n"); // second version
    await db.query("INSERT INTO bedrock_usage (team_id, model, call_type, estimated_cost_usd) VALUES ($1, 'm', 'seed', 0.01)", [guest]);
    await db.query("UPDATE guest_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [guest]);

    const pRes = await cron();
    expect(pRes.status).toBe(200);
    expect((await pRes.json()).failed).toEqual([]);

    expect(await allVersions(env("S3_RAW_BUCKET"), `${guest}/`)).toEqual([]);
    expect(await allVersions(env("S3_PROCESSED_BUCKET"), `processed/${pipeline_id}/`)).toEqual([]);
    expect((await db.query("SELECT 1 FROM pipelines WHERE team_id = $1", [guest])).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM guest_sessions WHERE id = $1", [guest])).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM bedrock_usage WHERE team_id = $1", [guest])).rowCount).toBe(1); // kept for the daily cap

    expect((await db.query("SELECT 1 FROM pipelines WHERE team_id = $1", [live])).rowCount).toBe(1);
    expect((await allVersions(env("S3_RAW_BUCKET"), `${live}/${liveRun.pipeline_id}/`)).length).toBeGreaterThan(0);
    expect((await db.query("SELECT 1 FROM pipelines WHERE team_id = $1", [user])).rowCount).toBe(1);
  });

  it("the purge needs the cron secret", async () => {
    const res = await purgeGuests(new Request("http://localhost/api/cron/purge-guests"));
    expect(res.status).toBe(401);
  });
});
