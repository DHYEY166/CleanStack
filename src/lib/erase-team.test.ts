import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn(), purge: vi.fn() }));
vi.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => h.query(...a),
  queryOne: (...a: unknown[]) => h.queryOne(...a),
  withTransaction: (fn: (tx: string) => unknown) => fn("tx"),
}));
vi.mock("@/lib/s3-erase", async (orig) => ({ ...(await orig<typeof import("@/lib/s3-erase")>()), purgePrefix: (...a: unknown[]) => h.purge(...a) }));

import { eraseTeam } from "./erase-team";

const s3 = {} as never;
beforeEach(() => {
  vi.clearAllMocks();
  process.env.S3_RAW_BUCKET = "raw";
  process.env.S3_PROCESSED_BUCKET = "proc";
  h.query.mockImplementation(async (sql: string) => (sql.includes("FROM pipelines WHERE") ? [{ id: "p1" }] : []));
  h.queryOne.mockResolvedValue({ count: "1" });
  h.purge.mockImplementation(async (_s: unknown, _b: string, prefix: string) => ({ prefix, deleted: 1, versioned: true, errors: [] }));
});
const deletes = () => h.query.mock.calls.map((c) => String(c[0])).filter((s) => s.startsWith("DELETE"));

describe("eraseTeam", () => {
  it("purges S3 then deletes rows including the guest session and usage", async () => {
    expect(await eraseTeam(s3, "guest_AAAAAAAAAAAAAAAAAAAAAA")).toEqual({ ok: true, deletedPipelines: 1, deletedS3Objects: 2, allVersionsPurged: true });
    expect(h.purge.mock.calls.map((c) => `${c[1]}:${c[2]}`)).toEqual(["raw:guest_AAAAAAAAAAAAAAAAAAAAAA/", "proc:processed/p1/"]);
    expect(deletes()).toContain("DELETE FROM bedrock_usage WHERE team_id = $1");
    expect(deletes()).toContain("DELETE FROM guest_sessions WHERE id = $1");
  });

  it("keeps bedrock_usage when asked (guest purge)", async () => {
    await eraseTeam(s3, "guest_AAAAAAAAAAAAAAAAAAAAAA", { keepUsage: true });
    expect(deletes()).not.toContain("DELETE FROM bedrock_usage WHERE team_id = $1");
  });

  it("leaves the DB intact when S3 fails, and refuses unsafe ids", async () => {
    h.purge.mockResolvedValueOnce({ prefix: "x/", deleted: 0, versioned: true, errors: ["k: AccessDenied"] });
    expect(await eraseTeam(s3, "guest_AAAAAAAAAAAAAAAAAAAAAA")).toEqual({ ok: false, stage: "s3" });
    expect(deletes()).toEqual([]);
    expect(await eraseTeam(s3, "../evil")).toEqual({ ok: false, stage: "unsafe_id" });
  });
});
