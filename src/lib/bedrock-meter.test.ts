import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock("@/lib/db", () => ({ query: (...a: unknown[]) => h.query(...a), queryOne: (...a: unknown[]) => h.queryOne(...a) }));

import { checkAiBudget, meterBedrockCall } from "./bedrock-meter";
import { BEDROCK_MODEL_ID } from "./ai-config";

const GUEST = "guest_AAAAAAAAAAAAAAAAAAAAAA";
const guestRow = (calls_hour: number, guest_total: number, guests_today: number) =>
  h.queryOne.mockResolvedValue({ calls_hour: String(calls_hour), guest_total: String(guest_total), guests_today: String(guests_today) });

beforeEach(() => { vi.clearAllMocks(); h.query.mockResolvedValue([]); });

describe("checkAiBudget: signed-in users", () => {
  it("uses the monthly hard cap", async () => {
    h.queryOne.mockImplementation(async (sql: string) =>
      sql.includes("ai_spend_limits") ? { soft_cap_usd: "50", hard_cap_usd: "200" } : { total: "199.99" });
    expect(await checkAiBudget("user_1")).toEqual({ ok: true });
    h.queryOne.mockImplementation(async (sql: string) =>
      sql.includes("ai_spend_limits") ? { soft_cap_usd: "50", hard_cap_usd: "200" } : { total: "200" });
    expect(await checkAiBudget("user_1")).toMatchObject({ ok: false, status: 402, scope: "team_month" });
  });
});

describe("checkAiBudget: guests", () => {
  it("allows a fresh guest and counts in one query scoped to the guest and to all guests today", async () => {
    guestRow(0, 0, 0);
    expect(await checkAiBudget(GUEST)).toEqual({ ok: true });
    const [sql, params] = h.queryOne.mock.calls[0];
    expect(params).toEqual([GUEST]);
    expect(sql).toContain("interval '1 hour'");
    expect(sql).toContain("team_id LIKE 'guest\\_%'");
    expect(sql).toContain("date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'");
  });

  it("refuses the 11th call in an hour, and a 3-call committee at 8", async () => {
    guestRow(9, 0.01, 0);
    expect(await checkAiBudget(GUEST)).toEqual({ ok: true });
    guestRow(10, 0.01, 0);
    expect(await checkAiBudget(GUEST)).toMatchObject({ ok: false, status: 429, scope: "guest_hourly" });
    guestRow(8, 0.01, 0);
    expect(await checkAiBudget(GUEST, 3)).toMatchObject({ ok: false, scope: "guest_hourly" });
    guestRow(7, 0.01, 0);
    expect(await checkAiBudget(GUEST, 3)).toEqual({ ok: true });
  });

  it("refuses at $0.25 for the guest and at $5 for all guests today", async () => {
    guestRow(0, 0.2499, 4.99);
    expect(await checkAiBudget(GUEST)).toEqual({ ok: true });
    guestRow(0, 0.25, 0.25);
    expect(await checkAiBudget(GUEST)).toMatchObject({ ok: false, status: 402, scope: "guest_total" });
    guestRow(0, 0, 5);
    expect(await checkAiBudget(GUEST)).toMatchObject({ ok: false, status: 429, scope: "guests_daily" });
  });
});

describe("meterBedrockCall", () => {
  it("records the call and resolves only after the insert (so the next check sees it)", async () => {
    let resolveInsert!: () => void;
    h.query.mockReturnValue(new Promise<void>((r) => { resolveInsert = r; }));
    let done = false;
    const p = meterBedrockCall({ teamId: GUEST, runId: null, callType: "chat_builder", model: BEDROCK_MODEL_ID, usage: { inputTokens: 1000, outputTokens: 100 } }).then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    resolveInsert();
    await p;
    expect(h.query.mock.calls[0][1].slice(0, 6)).toEqual([GUEST, null, BEDROCK_MODEL_ID, "chat_builder", 1000, 100]);
  });

  it("never throws when the insert fails", async () => {
    h.query.mockRejectedValue(new Error("db down"));
    await expect(meterBedrockCall({ teamId: GUEST, runId: null, callType: "x", model: "m", usage: {} })).resolves.toBeUndefined();
  });
});
