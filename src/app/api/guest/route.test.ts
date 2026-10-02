import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ auth: vi.fn(), queryOne: vi.fn(), turnstile: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: () => h.auth() }));
vi.mock("@/lib/db", () => ({ queryOne: (...a: unknown[]) => h.queryOne(...a) }));
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: (...a: unknown[]) => h.turnstile(...a) }));

import { DELETE, GET, POST } from "./route";
import { GUEST_COOKIE, signGuestToken, verifyGuestToken } from "@/lib/guest";
import { GUEST_LIMITS } from "@/lib/guest-limits";

const SECRET = "unit-test-guest-secret-0123456789abcdef";
const req = (method: string, init: { cookie?: string; body?: unknown; ip?: string } = {}) =>
  new NextRequest("http://localhost/api/guest", {
    method,
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": init.ip ?? "203.0.113.7",
      ...(init.cookie ? { cookie: `${GUEST_COOKIE}=${init.cookie}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GUEST_COOKIE_SECRET = SECRET;
  h.auth.mockResolvedValue({ userId: null });
  h.turnstile.mockResolvedValue(true);
  h.queryOne.mockImplementation(async (sql: string, params: unknown[]) =>
    sql.startsWith("INSERT INTO guest_sessions") ? { id: params[0] } : { n: 0 });
});
afterEach(() => { delete process.env.GUEST_COOKIE_SECRET; });

describe("POST /api/guest", () => {
  it("404s when guest access is off", async () => {
    delete process.env.GUEST_COOKIE_SECRET;
    expect((await POST(req("POST"))).status).toBe(404);
    expect((await DELETE()).status).toBe(404);
    expect(await (await GET(req("GET"))).json()).toEqual({ enabled: false, guest: null });
  });

  it("issues a signed httpOnly 24 h cookie and records the session with a hashed IP and the caps", async () => {
    const res = await POST(req("POST"));
    expect(res.status).toBe(201);
    const cookie = res.cookies.get(GUEST_COOKIE)!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("lax");
    expect(cookie.secure).toBe(true);
    const session = await verifyGuestToken(cookie.value, SECRET);
    expect(session).not.toBeNull();
    expect(session!.expiresAt - Math.floor(Date.now() / 1000)).toBeGreaterThan(24 * 3600 - 10);

    const [sql, params] = h.queryOne.mock.calls[0];
    expect(sql).toContain("INSERT INTO guest_sessions");
    expect(params[0]).toBe(session!.guestId);
    expect(params[1]).not.toContain("203.0.113.7");
    expect(params.slice(2)).toEqual([24 * 3600, GUEST_LIMITS.guestsPerIpPerDay, GUEST_LIMITS.guestsPerDay]);
  });

  it("reuses a valid guest cookie instead of creating another session", async () => {
    const token = await signGuestToken({ guestId: "guest_AAAAAAAAAAAAAAAAAAAAAA", expiresAt: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    const res = await POST(req("POST", { cookie: token }));
    expect(res.status).toBe(200);
    expect((await res.json()).reused).toBe(true);
    expect(h.queryOne).not.toHaveBeenCalled();
  });

  it("409s for a signed-in account", async () => {
    h.auth.mockResolvedValue({ userId: "user_2abc" });
    expect((await POST(req("POST"))).status).toBe(409);
  });

  it("403s when Turnstile rejects the token", async () => {
    h.turnstile.mockResolvedValue(false);
    const res = await POST(req("POST", { body: { turnstile_token: "bad" } }));
    expect(res.status).toBe(403);
    expect(h.turnstile).toHaveBeenCalledWith("bad", "203.0.113.7");
    expect(h.queryOne).not.toHaveBeenCalled();
  });

  it("429s at the per-IP cap and 503s at the global cap", async () => {
    h.queryOne.mockImplementation(async (sql: string) => (sql.startsWith("INSERT") ? null : { n: GUEST_LIMITS.guestsPerIpPerDay }));
    const perIp = await POST(req("POST"));
    expect(perIp.status).toBe(429);
    expect(perIp.cookies.get(GUEST_COOKIE)).toBeUndefined();

    h.queryOne.mockImplementation(async (sql: string) => (sql.startsWith("INSERT") ? null : { n: 1 }));
    expect((await POST(req("POST"))).status).toBe(503);
  });

  it("answers JSON 500 when the database fails", async () => {
    h.queryOne.mockRejectedValue(new Error("db down"));
    const res = await POST(req("POST"));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/Could not start a guest session/);
  });
});

describe("GET/DELETE /api/guest", () => {
  it("reports the session and clears it", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 60;
    const token = await signGuestToken({ guestId: "guest_AAAAAAAAAAAAAAAAAAAAAA", expiresAt }, SECRET);
    expect(await (await GET(req("GET", { cookie: token }))).json()).toEqual({
      enabled: true, guest: { expires_at: new Date(expiresAt * 1000).toISOString() },
    });
    expect(await (await GET(req("GET", { cookie: "forged" }))).json()).toEqual({ enabled: true, guest: null });
    const del = await DELETE();
    expect(del.headers.get("set-cookie")).toMatch(new RegExp(`${GUEST_COOKIE}=;`));
  });
});
