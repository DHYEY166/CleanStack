import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  email: vi.fn(),
  quota: vi.fn(),
  limit: vi.fn(),
  queryOneWithTeam: vi.fn(),
  queryOne: vi.fn(),
  getSignedUrl: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => h.auth(),
  currentUser: async () => { const e = await h.email(); return e ? { primaryEmailAddress: { emailAddress: e } } : null; },
}));
vi.mock("@/lib/quota-cache", () => ({ getCachedQuota: (...a: unknown[]) => h.quota(...a) }));
vi.mock("@/lib/db", () => ({
  queryOneWithTeam: (...a: unknown[]) => h.queryOneWithTeam(...a),
  queryOne: (...a: unknown[]) => h.queryOne(...a),
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: (...a: unknown[]) => h.getSignedUrl(...a) }));
// Real checkRateLimit, with a limiter whose Upstash calls we control.
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  uploadLimiter: { limit: (...a: unknown[]) => h.limit(...a) },
}));

const savedBucket = process.env.S3_RAW_BUCKET;
process.env.S3_RAW_BUCKET = "raw-bucket";
afterAll(() => { if (savedBucket === undefined) delete process.env.S3_RAW_BUCKET; else process.env.S3_RAW_BUCKET = savedBucket; });

const { POST } = await import("./route");

const OK_QUOTA = { blocked: false, used: 0, includedRows: 1000, plan: "free" };
const call = (body: unknown = { pipeline_id: "11111111-2222-3333-4444-555555555555", filename: "Email-Tracking.csv" }) =>
  POST(new Request("http://x/api/upload", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }) as never);

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ userId: "user_1" });
  h.email.mockResolvedValue("a@example.com");
  h.quota.mockResolvedValue(OK_QUOTA);
  h.limit.mockResolvedValue({ success: true, limit: 20, remaining: 19, reset: 0 });
  h.queryOneWithTeam.mockResolvedValue({ id: "p" });
  h.queryOne.mockResolvedValue({ id: "run_1" });
  h.getSignedUrl.mockResolvedValue("https://raw-bucket.s3.amazonaws.com/put");
});

describe("POST /api/upload", () => {
  it("returns a presigned URL", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ presigned_url: "https://raw-bucket.s3.amazonaws.com/put", run_id: "run_1" });
  });

  it("still uploads when Upstash fails DNS (the production 500 with an empty body)", async () => {
    h.limit.mockRejectedValue(new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND gone.upstash.io") }));
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).run_id).toBe("run_1");
  });

  it("still uploads when the Clerk email lookup fails (no admin bypass)", async () => {
    h.email.mockRejectedValue(new TypeError("fetch failed"));
    expect((await call()).status).toBe(200);
    expect(h.quota).toHaveBeenCalledWith("user_1", null, "user_1");
  });

  it("answers JSON naming the step when the quota check throws", async () => {
    h.quota.mockRejectedValue(new Error('relation "subscriptions" does not exist'));
    const res = await call();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: "Upload could not be started: Could not check your monthly usage quota. Please retry.", stage: "quota" });
    expect(JSON.stringify(body)).not.toContain("subscriptions"); // no internals leak to the browser
    expect(h.queryOne).not.toHaveBeenCalled();
  });

  it("answers JSON when auth itself throws", async () => {
    h.auth.mockRejectedValue(new Error("clerk down"));
    const res = await call();
    expect(res.status).toBe(503);
    expect((await res.json()).stage).toBe("auth");
  });

  it("answers JSON when presigning fails", async () => {
    h.getSignedUrl.mockRejectedValue(new Error("no credentials"));
    const res = await call();
    expect(res.status).toBe(500);
    expect((await res.json()).stage).toBe("presign");
  });

  it("400s on a non-JSON body instead of crashing", async () => {
    const res = await call("not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "pipeline_id and filename required" });
  });

  it("keeps 429 when the limit is hit, and 402 when the quota is exhausted", async () => {
    h.limit.mockResolvedValueOnce({ success: false, limit: 20, remaining: 0, reset: Date.now() + 1000 });
    expect((await call()).status).toBe(429);
    h.quota.mockResolvedValueOnce({ ...OK_QUOTA, blocked: true, used: 1000 });
    expect((await call()).status).toBe(402);
  });
});
