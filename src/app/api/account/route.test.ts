import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const auth = vi.fn();
const query = vi.fn();
const queryOne = vi.fn();
const withTransaction = vi.fn();
const purgePrefix = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: () => auth() }));
vi.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => query(...a),
  queryOne: (...a: unknown[]) => queryOne(...a),
  withTransaction: (fn: (tx: string) => unknown) => withTransaction(fn),
}));
vi.mock("@/lib/s3-erase", async (orig) => ({
  ...(await orig<typeof import("@/lib/s3-erase")>()),
  purgePrefix: (...a: unknown[]) => purgePrefix(...a),
}));

const { DELETE } = await import("./route");
const del = (confirm = "true") => DELETE(new NextRequest(`http://x/api/account?confirm=${confirm}`, { method: "DELETE" }));

describe("DELETE /api/account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.S3_RAW_BUCKET = "raw";
    process.env.S3_PROCESSED_BUCKET = "proc";
    auth.mockResolvedValue({ userId: "user_abc" });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM pipelines WHERE")) return [{ id: "p1" }];
      if (sql.includes("FROM pipeline_runs")) {
        return [
          { raw_s3_key: "user_abc/p1/r1/raw.pdf", processed_s3_key: "processed/p1/r1/output.txt" },
          { raw_s3_key: "legacy/r9/raw.csv", processed_s3_key: null },
        ];
      }
      return [];
    });
    withTransaction.mockImplementation(async (fn: (tx: string) => unknown) => fn("tx"));
    queryOne.mockResolvedValue({ count: "1" });
    purgePrefix.mockImplementation(async (_s3: unknown, _b: string, prefix: string) => ({
      prefix, deleted: 2, versioned: true, errors: [],
    }));
  });

  it("requires explicit confirmation", async () => {
    expect((await del("no")).status).toBe(400);
    expect(purgePrefix).not.toHaveBeenCalled();
  });

  it("purges whole user, pipeline and stray prefixes before deleting rows", async () => {
    const res = await del();
    expect(res.status).toBe(200);
    const targets = purgePrefix.mock.calls.map((c) => `${c[1]}:${c[2]}`);
    expect(targets).toEqual(["raw:user_abc/", "raw:legacy/r9/", "proc:processed/p1/"]);
    expect(withTransaction).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, deleted_s3_objects: 6, all_versions_purged: true });
  });

  it("keeps the database intact when S3 deletion fails", async () => {
    purgePrefix.mockRejectedValueOnce(new Error("S3 down"));
    expect((await del()).status).toBe(500);
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("keeps the database intact when some objects could not be deleted", async () => {
    purgePrefix.mockResolvedValueOnce({ prefix: "user_abc/", deleted: 0, versioned: true, errors: ["k@v: AccessDenied"] });
    expect((await del()).status).toBe(500);
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("refuses to run with an unexpected user id or missing buckets", async () => {
    auth.mockResolvedValueOnce({ userId: "../evil" });
    expect((await del()).status).toBe(500);
    delete process.env.S3_RAW_BUCKET;
    expect((await del()).status).toBe(500);
    expect(purgePrefix).not.toHaveBeenCalled();
  });
});
