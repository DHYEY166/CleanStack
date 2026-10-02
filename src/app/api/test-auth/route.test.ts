import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { DELETE, GET, POST } from "./route";

const ENV_KEYS = ["CLEANSTACK_TEST_MODE", "VERCEL", "VERCEL_ENV", "AWS_LAMBDA_FUNCTION_NAME"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const jsonPost = (body: unknown) =>
  new NextRequest("http://localhost:3000/api/test-auth", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const formPost = (fields: Record<string, string>) =>
  new NextRequest("http://localhost:3000/api/test-auth", { method: "POST", body: new URLSearchParams(fields), headers: { "content-type": "application/x-www-form-urlencoded" } });

describe("/api/test-auth is unreachable outside test mode", () => {
  it.each([
    ["flag unset", {}],
    ["flag 'true' (not exactly 1)", { CLEANSTACK_TEST_MODE: "true" }],
    ["flag on Vercel", { CLEANSTACK_TEST_MODE: "1", VERCEL: "1" }],
    ["flag on a Vercel preview", { CLEANSTACK_TEST_MODE: "1", VERCEL_ENV: "preview" }],
    ["flag in a Lambda", { CLEANSTACK_TEST_MODE: "1", AWS_LAMBDA_FUNCTION_NAME: "x" }],
  ])("404 and no cookie: %s", async (_label, env) => {
    Object.assign(process.env, env);
    for (const res of [await POST(jsonPost({ user_id: "user_test_a" })), await DELETE(), await GET()]) {
      expect(res.status).toBe(404);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });
});

describe("/api/test-auth in test mode", () => {
  beforeEach(() => { process.env.CLEANSTACK_TEST_MODE = "1"; });

  it("sets an httpOnly cookie for a valid test id", async () => {
    const res = await POST(jsonPost({ user_id: "user_test_a" }));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("cs_test_user=user_test_a");
    expect(cookie.toLowerCase()).toContain("httponly");
  });

  it("rejects ids outside the test namespace", async () => {
    expect((await POST(jsonPost({ user_id: "user_2realclerkid" }))).status).toBe(400);
  });

  it("form posts redirect only to same-origin paths", async () => {
    const ok = await POST(formPost({ user_id: "user_test_a", redirect_url: "/pipelines/new" }));
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("http://localhost:3000/pipelines/new");
    for (const evil of ["//evil.example", "https://evil.example", "/\\evil.example"]) {
      const res = await POST(formPost({ user_id: "user_test_a", redirect_url: evil }));
      expect(res.headers.get("location")).toBe("http://localhost:3000/dashboard");
    }
  });

  it("DELETE clears the cookie", async () => {
    const res = await DELETE();
    expect(res.headers.get("set-cookie")).toMatch(/cs_test_user=;/);
  });
});
