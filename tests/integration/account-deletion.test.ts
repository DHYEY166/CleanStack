/**
 * DELETE /api/account against versioned LocalStack buckets and real Postgres:
 * every object version AND delete marker under the user's prefixes is purged,
 * DB rows are removed, and other users' data is untouched.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/auth", async () => (await import("./helpers")).authMock);

import { allVersions, authState, db, env, newUser, putObject, request, s3 } from "./helpers";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { DELETE as deleteAccount } from "@/app/api/account/route";
import { closePgPool } from "@/lib/db-pg";

afterAll(async () => {
  await closePgPool();
  await db.end();
});

/** A user with one pipeline/run whose raw and processed files have several versions. */
async function seedUser() {
  const user = newUser();
  const pipelineId = randomUUID(), runId = randomUUID();
  const rawKey = `${user}/${pipelineId}/${runId}/raw.csv`;
  const procKey = `processed/${pipelineId}/${runId}/output.csv`;
  await db.query("INSERT INTO pipelines (id, name, owner_id, team_id) VALUES ($1, 'del', $2, $2)", [pipelineId, user]);
  await db.query(
    "INSERT INTO pipeline_runs (id, pipeline_id, status, raw_s3_key, processed_s3_key) VALUES ($1, $2, 'completed', $3, $4)",
    [runId, pipelineId, rawKey, procKey]);
  await db.query("INSERT INTO bedrock_usage (team_id, run_id, model, call_type, input_tokens, output_tokens, estimated_cost_usd) VALUES ($1, $2, 'm', 'suggest_transforms', 1, 1, 0)", [user, runId]);

  const raw = env("S3_RAW_BUCKET"), proc = env("S3_PROCESSED_BUCKET");
  for (const v of ["v1", "v2", "v3"]) await putObject(raw, rawKey, `a,b\n${v},1\n`);
  await putObject(raw, `${user}/${pipelineId}/${runId}/extracted_text.txt`, "text");
  await s3.send(new DeleteObjectCommand({ Bucket: raw, Key: `${user}/${pipelineId}/${runId}/extracted_text.txt` })); // delete marker
  for (const v of ["v1", "v2"]) await putObject(proc, procKey, `a,b\n${v},1\n`);
  await putObject(proc, `processed/${pipelineId}/${runId}/audit.csv`, "__orig_a\nx\n");
  return { user, pipelineId, runId, rawPrefix: `${user}/`, procPrefix: `processed/${pipelineId}/` };
}

describe("DELETE /api/account", () => {
  it("purges every version and delete marker, then the DB rows, and nothing of other users", async () => {
    const victim = await seedUser();
    const bystander = await seedUser();
    const raw = env("S3_RAW_BUCKET"), proc = env("S3_PROCESSED_BUCKET");

    const before = [...await allVersions(raw, victim.rawPrefix), ...await allVersions(proc, victim.procPrefix)];
    expect(before).toHaveLength(3 + 1 + 1 + 2 + 1); // raw versions, text version + marker, output versions, audit
    expect(before.some((v) => !("Size" in v) || v.Size === undefined)).toBe(true); // includes a delete marker

    authState.userId = victim.user;
    const res = await deleteAccount(request("/api/account?confirm=true", { method: "DELETE" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, deleted_pipelines: 1, all_versions_purged: true, deleted_s3_objects: before.length });

    expect(await allVersions(raw, victim.rawPrefix)).toEqual([]);
    expect(await allVersions(proc, victim.procPrefix)).toEqual([]);
    expect((await db.query("SELECT 1 FROM pipelines WHERE team_id = $1", [victim.user])).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM pipeline_runs WHERE id = $1", [victim.runId])).rowCount).toBe(0); // cascade
    expect((await db.query("SELECT 1 FROM bedrock_usage WHERE team_id = $1", [victim.user])).rowCount).toBe(0);

    expect(await allVersions(raw, bystander.rawPrefix)).toHaveLength(5);
    expect(await allVersions(proc, bystander.procPrefix)).toHaveLength(3);
    expect((await db.query("SELECT 1 FROM pipelines WHERE team_id = $1", [bystander.user])).rowCount).toBe(1);

    // clean up the bystander
    authState.userId = bystander.user;
    expect((await deleteAccount(request("/api/account?confirm=true", { method: "DELETE" }))).status).toBe(200);
  });

  it("deletes nothing without ?confirm=true", async () => {
    const u = await seedUser();
    authState.userId = u.user;
    expect((await deleteAccount(request("/api/account", { method: "DELETE" }))).status).toBe(400);
    expect(await allVersions(env("S3_RAW_BUCKET"), u.rawPrefix)).toHaveLength(5);
    expect((await db.query("SELECT 1 FROM pipelines WHERE team_id = $1", [u.user])).rowCount).toBe(1);
    expect((await deleteAccount(request("/api/account?confirm=true", { method: "DELETE" }))).status).toBe(200);
  });
});
