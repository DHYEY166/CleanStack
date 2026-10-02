import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest, type NextFetchEvent } from "next/server";
import middleware from "@/middleware";
import { GUEST_COOKIE, signGuestToken } from "@/lib/guest";

// Test-mode branch of the middleware (the Clerk branch needs real keys); it applies
// the same protected-route and guest rules as the Clerk branch.
const SECRET = "unit-test-guest-secret-0123456789abcdef";
const saved = { ...process.env };
beforeEach(() => {
  process.env.CLEANSTACK_TEST_MODE = "1";
  process.env.GUEST_COOKIE_SECRET = SECRET;
  for (const k of ["VERCEL", "VERCEL_ENV", "VERCEL_URL", "AWS_LAMBDA_FUNCTION_NAME", "AWS_EXECUTION_ENV"]) delete process.env[k];
});
afterEach(() => { process.env = { ...saved }; });

const guestToken = (exp = Math.floor(Date.now() / 1000) + 600) =>
  signGuestToken({ guestId: "guest_AAAAAAAAAAAAAAAAAAAAAA", expiresAt: exp }, SECRET);
const run = (path: string, cookie?: string) =>
  middleware(new NextRequest(`http://localhost:3000${path}`, { headers: cookie ? { cookie } : {} }), {} as NextFetchEvent) as Promise<Response>;

describe("middleware: guests", () => {
  it("a valid guest cookie passes protected pages and APIs", async () => {
    const cookie = `${GUEST_COOKIE}=${await guestToken()}`;
    for (const path of ["/dashboard", "/pipelines/new", "/api/upload", "/api/pipelines"]) {
      const res = await run(path, cookie);
      expect(res.headers.get("x-middleware-next"), path).toBe("1");
    }
    const root = await run("/", cookie);
    expect(root.headers.get("location")).toBe("http://localhost:3000/dashboard");
  });

  it("forged, expired or disabled guest cookies do not", async () => {
    const forged = `${GUEST_COOKIE}=guest_AAAAAAAAAAAAAAAAAAAAAA.9999999999.AAAA`;
    expect((await run("/api/upload", forged)).status).toBe(401);
    const expired = `${GUEST_COOKIE}=${await guestToken(Math.floor(Date.now() / 1000) - 5)}`;
    expect((await run("/dashboard", expired)).headers.get("location")).toContain("/sign-in");
    const valid = `${GUEST_COOKIE}=${await guestToken()}`;
    delete process.env.GUEST_COOKIE_SECRET;
    expect((await run("/api/pipelines", valid)).status).toBe(401);
  });
});
