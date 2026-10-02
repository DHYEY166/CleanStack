import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, type NextFetchEvent } from "next/server";

const clerkHandler = vi.hoisted(() => vi.fn(() => new Response("clerk")));
vi.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: () => clerkHandler,
  createRouteMatcher: (patterns: string[]) => (req: NextRequest) =>
    patterns.some((p) => new RegExp(`^${p}$`).test(req.nextUrl.pathname)),
}));

import middleware from "./middleware";

const ev = {} as NextFetchEvent;
const req = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost:3000${path}`, { headers: cookie ? { cookie: `cs_test_user=${cookie}` } : {} });

const ENV_KEYS = ["CLEANSTACK_TEST_MODE", "VERCEL"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } clerkHandler.mockClear(); });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe("middleware", () => {
  it("uses Clerk outside test mode, even with a test cookie", async () => {
    await middleware(req("/dashboard", "user_test_a"), ev);
    expect(clerkHandler).toHaveBeenCalledTimes(1);
  });

  it("uses Clerk when the test flag is set on Vercel", async () => {
    process.env.CLEANSTACK_TEST_MODE = "1";
    process.env.VERCEL = "1";
    await middleware(req("/dashboard", "user_test_a"), ev);
    expect(clerkHandler).toHaveBeenCalledTimes(1);
  });

  describe("test mode", () => {
    beforeEach(() => { process.env.CLEANSTACK_TEST_MODE = "1"; });

    it("redirects protected pages to /sign-in without the cookie", async () => {
      const res = (await middleware(req("/dashboard?x=1"), ev)) as Response;
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("http://localhost:3000/sign-in?redirect_url=%2Fdashboard%3Fx%3D1");
      expect(clerkHandler).not.toHaveBeenCalled();
    });

    it("401s protected APIs without the cookie or with a non-test id", async () => {
      expect(((await middleware(req("/api/upload"), ev)) as Response).status).toBe(401);
      expect(((await middleware(req("/api/upload", "user_2real"), ev)) as Response).status).toBe(401);
    });

    it("lets signed-in test users through and redirects / to /dashboard", async () => {
      const through = (await middleware(req("/api/upload", "user_test_a"), ev)) as Response;
      expect(through.headers.get("x-middleware-next")).toBe("1");
      const root = (await middleware(req("/", "user_test_a"), ev)) as Response;
      expect(root.headers.get("location")).toBe("http://localhost:3000/dashboard");
    });
  });
});
