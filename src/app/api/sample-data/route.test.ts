import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  userId: "user_1" as string | null, queryOne: vi.fn(), query: vi.fn(), send: vi.fn(),
  insertGuestRun: vi.fn(), refusal: vi.fn(), quota: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ userId: h.userId }), currentUserEmail: async () => null }));
vi.mock("@/lib/db", () => ({ queryOne: (...a: unknown[]) => h.queryOne(...a), query: (...a: unknown[]) => h.query(...a) }));
vi.mock("@/lib/quota-cache", () => ({ getCachedQuota: (...a: unknown[]) => h.quota(...a) }));
vi.mock("@/lib/rate-limit", () => ({ uploadLimiter: {}, checkRateLimit: async () => null }));
vi.mock("@/lib/guest-quota", async (orig) => ({
  ...(await orig<typeof import("@/lib/guest-quota")>()),
  insertGuestRun: (...a: unknown[]) => h.insertGuestRun(...a),
  guestUploadRefusal: (...a: unknown[]) => h.refusal(...a),
}));
vi.mock("@aws-sdk/client-s3", async (orig) => {
  const mod = await orig<typeof import("@aws-sdk/client-s3")>();
  return { ...mod, S3Client: class { send = (...a: unknown[]) => h.send(...a); } };
});

process.env.S3_RAW_BUCKET = "raw-bucket";
const { POST } = await import("./route");
import { DEMO_TEMPLATE_ID, SAMPLE_CSV } from "@/lib/sample-data";

const GUEST = "guest_AAAAAAAAAAAAAAAAAAAAAA";
beforeEach(() => {
  vi.clearAllMocks();
  h.userId = "user_1";
  h.quota.mockResolvedValue({ blocked: false });
  h.queryOne.mockImplementation(async (sql: string) => (sql.includes("INSERT INTO pipelines") ? { id: "p1" } : { id: "r1" }));
  h.send.mockResolvedValue({});
});

describe("POST /api/sample-data", () => {
  it("creates a pipeline on the demo template and writes the bundled CSV to the raw bucket", async () => {
    const res = await POST();
    expect(res.status).toBe(201);
    const { pipeline_id, run_id } = await res.json();
    expect(pipeline_id).toBe("p1");
    expect(h.queryOne.mock.calls[0][1]).toContain(DEMO_TEMPLATE_ID);
    const put = h.send.mock.calls[0][0].input;
    expect(put).toMatchObject({ Bucket: "raw-bucket", Key: `user_1/p1/${run_id}/raw.csv`, Body: SAMPLE_CSV, ContentType: "text/csv" });
  });

  it("guests: capped pipeline + run inserts; over the upload cap removes the empty pipeline and answers 429", async () => {
    h.userId = GUEST;
    h.insertGuestRun.mockResolvedValue({ id: "r1" });
    expect((await POST()).status).toBe(201);
    expect(h.queryOne.mock.calls[0][0]).toContain("(SELECT count(*) FROM pipelines WHERE team_id = $3) < $4");
    expect(h.queryOne.mock.calls[0][1]).toEqual(expect.arrayContaining([GUEST, 5, DEMO_TEMPLATE_ID]));

    vi.clearAllMocks();
    h.quota.mockResolvedValue({ blocked: false });
    h.queryOne.mockResolvedValue({ id: "p2" });
    h.insertGuestRun.mockResolvedValue(null);
    h.refusal.mockResolvedValue("Guests can upload 3 files. Sign up to keep going.");
    const res = await POST();
    expect(res.status).toBe(429);
    expect(h.query).toHaveBeenCalledWith("DELETE FROM pipelines WHERE id = $1 AND team_id = $2", ["p2", GUEST]);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("fails the run when S3 rejects the write, and 402s over quota", async () => {
    h.send.mockRejectedValue(new Error("AccessDenied"));
    expect((await POST()).status).toBe(500);
    expect(h.queryOne.mock.calls.at(-1)![0]).toContain("status = 'failed'");
    h.quota.mockResolvedValue({ blocked: true, plan: "guest", used: 10000, includedRows: 10000 });
    expect((await POST()).status).toBe(402);
    h.userId = null;
    expect((await POST()).status).toBe(401);
  });
});
