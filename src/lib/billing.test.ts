import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ queryOne: vi.fn() }));
vi.mock("@/lib/db", () => ({ queryOne: (...a: unknown[]) => h.queryOne(...a) }));

import { checkQuota, isAdmin, quotaBlockedMessage } from "./billing";

const GUEST = "guest_AAAAAAAAAAAAAAAAAAAAAA";
beforeEach(() => vi.clearAllMocks());

describe("guest quota", () => {
  it("is 10,000 rows all-time, hard-capped, ignoring runs refused for size", async () => {
    h.queryOne.mockResolvedValue({ total: "9999" });
    expect(await checkQuota(GUEST, null, GUEST)).toMatchObject({ plan: "guest", includedRows: 10_000, used: 9999, remaining: 1, blocked: false, hardCap: true });
    const [sql, params] = h.queryOne.mock.calls[0];
    expect(sql).not.toContain("created_at >=");
    expect(sql).toContain("row_count_raw <= $2");
    expect(params).toEqual([GUEST, 5000]);
    h.queryOne.mockResolvedValue({ total: "10000" });
    expect((await checkQuota(GUEST, null, GUEST)).blocked).toBe(true);
  });

  it("never treats a guest as admin or reads subscriptions", async () => {
    expect(isAdmin("someone@example.com", GUEST)).toBe(false);
    h.queryOne.mockResolvedValue({ total: "0" });
    await checkQuota(GUEST, null, GUEST);
    expect(h.queryOne.mock.calls.some(([sql]) => String(sql).includes("subscriptions"))).toBe(false);
  });

  it("leaves signed-in users on their plan", async () => {
    h.queryOne.mockImplementation(async (sql: string) => (sql.includes("subscriptions") ? null : { total: "10" }));
    expect(await checkQuota("user_1", null, "user_1")).toMatchObject({ plan: "free", includedRows: 50_000, used: 10 });
  });

  it("guest and user messages", () => {
    const base = { used: 10000, includedRows: 10000, remaining: 0, hardCap: true, blocked: true, isAdmin: false };
    expect(quotaBlockedMessage({ ...base, plan: "guest" })).toBe("Guest row limit reached (10,000 / 10,000 rows). Sign up to keep going.");
    expect(quotaBlockedMessage({ ...base, used: 50000, includedRows: 50000, plan: "free" }))
      .toBe("Monthly row limit reached (50,000 / 50,000 rows on free plan). Upgrade at /pricing to continue.");
  });
});
