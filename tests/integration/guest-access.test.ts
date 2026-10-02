/**
 * Guest access against real Postgres + LocalStack: /api/guest issues a signed
 * cookie and enforces the per-IP cap in guest_sessions; a guest uploads through
 * the 2 MB presigned POST; the profiler refuses an oversized object (LocalStack
 * does not enforce POST policies, so this is the backstop real S3 also has).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/auth", async () => (await import("./helpers")).authMock);

import { authState, db, env, invokeLambda, postUpload, purgeQueue, receive, request } from "./helpers";
import { POST as startGuest } from "@/app/api/guest/route";
import { POST as createPipeline } from "@/app/api/pipelines/route";
import { POST as upload } from "@/app/api/upload/route";
import { GUEST_COOKIE, guestFromCookie } from "@/lib/guest";
import { GUEST_LIMITS } from "@/lib/guest-limits";
import { closePgPool } from "@/lib/db-pg";

const ip = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}-${randomUUID().slice(0, 4)}`;
const guestRequest = (forIp: string) => request("/api/guest", { method: "POST", body: {}, headers: { "x-forwarded-for": forIp } });
const created: string[] = [];

beforeAll(async () => { await purgeQueue(env("RAW_EVENTS_QUEUE_URL")); });
afterAll(async () => {
  await db.query("DELETE FROM pipelines WHERE team_id = ANY($1)", [created]);
  await db.query("DELETE FROM guest_sessions WHERE id = ANY($1)", [created]);
  await closePgPool();
  await db.end();
});

async function newGuest(forIp = ip()): Promise<string> {
  const res = await startGuest(guestRequest(forIp));
  expect(res.status).toBe(201);
  const session = await guestFromCookie(res.cookies.get(GUEST_COOKIE)!.value);
  created.push(session!.guestId);
  return session!.guestId;
}

describe("guest sessions", () => {
  it("records the session in guest_sessions with a hashed IP and a 24 h expiry", async () => {
    const id = await newGuest("203.0.113.50");
    const { rows } = await db.query("SELECT ip_hash, expires_at - created_at AS ttl FROM guest_sessions WHERE id = $1", [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].ip_hash).not.toContain("203.0.113.50");
    expect(rows[0].ttl.hours ?? rows[0].ttl.days * 24).toBe(24);
  });

  it(`refuses the ${GUEST_LIMITS.guestsPerIpPerDay + 1}th session from one IP in 24 h`, async () => {
    const shared = ip();
    for (let i = 0; i < GUEST_LIMITS.guestsPerIpPerDay; i++) await newGuest(shared);
    const res = await startGuest(guestRequest(shared));
    expect(res.status).toBe(429);
    expect(res.cookies.get(GUEST_COOKIE)).toBeUndefined();
    expect((await startGuest(guestRequest(ip()))).status).toBe(201); // another IP is fine
  });
});

describe("guest uploads", () => {
  it("a guest's presigned POST carries the 2 MB policy and the profiler rejects a larger object", async () => {
    const guest = await newGuest();
    authState.userId = guest;
    const { pipeline } = await (await createPipeline(request("/api/pipelines", { method: "POST", body: { name: "guest it" } }))).json();
    expect(pipeline.team_id).toBe(guest);

    // Declared size over 2 MB: refused before anything is created.
    const tooBig = await upload(request("/api/upload", { method: "POST", body: { pipeline_id: pipeline.id, filename: "big.csv", size: 3 * 1024 * 1024 } }));
    expect(tooBig.status).toBe(413);

    // A client that lies about the size: S3 would reject it (policy); the profiler is the backstop.
    const res = await upload(request("/api/upload", { method: "POST", body: { pipeline_id: pipeline.id, filename: "big.csv", size: 1000 } }));
    expect(res.status).toBe(200);
    const { upload: post, run_id, s3_key, max_bytes } = await res.json();
    expect(max_bytes).toBe(2 * 1024 * 1024);
    expect(s3_key.startsWith(`${guest}/`)).toBe(true);
    const policy = JSON.parse(Buffer.from(post.fields.Policy, "base64").toString());
    expect(policy.conditions).toContainEqual(["content-length-range", 1, 2 * 1024 * 1024]);

    const big = "id,v\n" + "1,x\n".repeat(600_000); // ~2.3 MB
    expect((await postUpload(post, big, "big.csv")).status).toBe(204);
    const [notification] = await receive(env("RAW_EVENTS_QUEUE_URL"), (m) => (m.Body ?? "").includes(run_id), 1, 0);
    expect(notification).toBeDefined();
    const profiled = await invokeLambda("profiler", JSON.parse(notification.Body!));
    expect(profiled.result).toEqual({ statusCode: 200, run_id, rejected: "too_large" });
    const { rows } = await db.query("SELECT status, error_message, row_count_raw FROM pipeline_runs WHERE id = $1", [run_id]);
    expect(rows[0]).toEqual({ status: "failed", error_message: "File is 2.3 MB; the upload limit is 2 MB per file.", row_count_raw: null });
  });
});
