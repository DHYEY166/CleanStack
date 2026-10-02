import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cookieStore = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (cookieStore.has(name) ? { name, value: cookieStore.get(name)! } : undefined) }),
}));
const clerk = vi.hoisted(() => ({
  auth: vi.fn(async () => ({ userId: "user_clerk_1" })),
  currentUser: vi.fn(async () => ({ primaryEmailAddress: { emailAddress: "real@example.com" } })),
  getUser: vi.fn(async () => ({ emailAddresses: [{ emailAddress: "owner@example.com" }] })),
}));
vi.mock("@clerk/nextjs/server", () => ({
  auth: clerk.auth,
  currentUser: clerk.currentUser,
  clerkClient: async () => ({ users: { getUser: clerk.getUser } }),
}));

import { auth, currentUserEmail, isValidTestUserId, TEST_USER_COOKIE, userEmailById } from "@/lib/auth";

const ENV_KEYS = ["CLEANSTACK_TEST_MODE", "VERCEL", "AWS_LAMBDA_FUNCTION_NAME"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  cookieStore.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe("auth facade, production path", () => {
  it("delegates to Clerk and ignores the test cookie", async () => {
    cookieStore.set(TEST_USER_COOKIE, "user_test_forged");
    expect(await auth()).toEqual({ userId: "user_clerk_1" });
    expect(await currentUserEmail()).toBe("real@example.com");
    expect(await userEmailById("user_clerk_1")).toBe("owner@example.com");
    expect(clerk.auth).toHaveBeenCalledTimes(1);
  });

  it("ignores the cookie when the test flag is set on Vercel", async () => {
    process.env.CLEANSTACK_TEST_MODE = "1";
    process.env.VERCEL = "1";
    cookieStore.set(TEST_USER_COOKIE, "user_test_forged");
    expect(await auth()).toEqual({ userId: "user_clerk_1" });
  });

  it("ignores the cookie when the test flag is set in a Lambda", async () => {
    process.env.CLEANSTACK_TEST_MODE = "1";
    process.env.AWS_LAMBDA_FUNCTION_NAME = "fn";
    cookieStore.set(TEST_USER_COOKIE, "user_test_forged");
    expect(await auth()).toEqual({ userId: "user_clerk_1" });
  });
});

describe("auth facade, test mode", () => {
  beforeEach(() => { process.env.CLEANSTACK_TEST_MODE = "1"; });

  it("reads the user id from the test cookie without calling Clerk", async () => {
    cookieStore.set(TEST_USER_COOKIE, "user_test_alice");
    expect(await auth()).toEqual({ userId: "user_test_alice" });
    expect(await currentUserEmail()).toBe("user_test_alice@e2e.cleanstack.test");
    expect(clerk.auth).not.toHaveBeenCalled();
    expect(clerk.currentUser).not.toHaveBeenCalled();
  });

  it("is signed out without a cookie or with a malformed one", async () => {
    expect(await auth()).toEqual({ userId: null });
    cookieStore.set(TEST_USER_COOKIE, "user_2abc"); // a real-looking Clerk id is not accepted
    expect(await auth()).toEqual({ userId: null });
    expect(await currentUserEmail()).toBeNull();
  });

  it("resolves owner emails only for test ids", async () => {
    expect(await userEmailById("user_test_bob")).toBe("user_test_bob@e2e.cleanstack.test");
    expect(await userEmailById("user_real")).toBeNull();
    expect(clerk.getUser).not.toHaveBeenCalled();
  });
});

describe("isValidTestUserId", () => {
  it.each([["user_test_a", true], ["user_test_", false], ["user_test_a;b", false], ["user_test_" + "x".repeat(65), false], [42, false]])(
    "%s -> %s", (v, ok) => expect(isValidTestUserId(v)).toBe(ok));
});
