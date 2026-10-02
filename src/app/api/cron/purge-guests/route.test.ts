import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ query: vi.fn(), erase: vi.fn() }));
vi.mock("@/lib/db", () => ({ query: (...a: unknown[]) => h.query(...a) }));
vi.mock("@/lib/erase-team", () => ({ eraseTeam: (...a: unknown[]) => h.erase(...a) }));

import { GET, PURGE_BATCH, PURGE_CANDIDATES_SQL } from "./route";

const call = (auth?: string) => GET(new Request("http://x/api/cron/purge-guests", { headers: auth ? { Authorization: auth } : {} }));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "cron-secret-0123456789abcdef0123456789";
  h.query.mockResolvedValue([{ team_id: "guest_AAAAAAAAAAAAAAAAAAAAAA" }, { team_id: "user_should_never_appear" }, { team_id: "guest_BBBBBBBBBBBBBBBBBBBBBB" }]);
  h.erase.mockImplementation(async (_s3: unknown, id: string) => (id.startsWith("guest_B") ? { ok: false, stage: "s3" } : { ok: true }));
});

describe("GET /api/cron/purge-guests", () => {
  it("requires the cron secret", async () => {
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await call("Bearer ")).status).toBe(401);
    expect(h.query).not.toHaveBeenCalled();
  });

  it("erases a batch of guests with the shared helper, keeping bedrock_usage, never a non-guest id", async () => {
    const res = await call("Bearer cron-secret-0123456789abcdef0123456789");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ purged: 1, failed: [{ team_id: "guest_BBBBBBBBBBBBBBBBBBBBBB", stage: "s3" }], more: false });
    expect(h.query.mock.calls[0][1]).toEqual([PURGE_BATCH]);
    expect(h.erase.mock.calls.map((c) => c[1])).toEqual(["guest_AAAAAAAAAAAAAAAAAAAAAA", "guest_BBBBBBBBBBBBBBBBBBBBBB"]);
    for (const c of h.erase.mock.calls) expect(c[2]).toEqual({ keepUsage: true });
  });

  it("selects expired sessions and orphaned guest teams, skipping active runs", () => {
    expect(PURGE_CANDIDATES_SQL).toContain("FROM guest_sessions WHERE expires_at < now()");
    expect(PURGE_CANDIDATES_SQL).toContain("p.team_id LIKE 'guest\\_%'");
    expect(PURGE_CANDIDATES_SQL).toContain("interval '30 minutes'");
  });
});
