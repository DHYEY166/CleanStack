import { describe, expect, it } from "vitest";
import type { Ratelimit } from "@upstash/ratelimit";
import { checkRateLimit } from "@/lib/rate-limit";

const limiter = (limit: () => Promise<unknown>) => ({ limit }) as unknown as Ratelimit;
const dnsFailure = () =>
  Promise.reject(new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND gone-db.upstash.io") }));

describe("checkRateLimit", () => {
  it("allows when Redis is not configured", async () => {
    expect(await checkRateLimit(null, "u")).toBeNull();
  });

  it("fails open (never throws) when Upstash is unreachable", async () => {
    expect(await checkRateLimit(limiter(dnsFailure), "u")).toBeNull();
  });

  it("returns 429 with rate-limit headers when the limit is hit", async () => {
    const reset = Date.now() + 30_000;
    const res = await checkRateLimit(limiter(async () => ({ success: false, limit: 20, remaining: 0, reset })), "u");
    expect(res?.status).toBe(429);
    expect(res?.headers.get("X-RateLimit-Limit")).toBe("20");
    expect(await res?.json()).toEqual({ error: "Too many requests. Please wait before trying again." });
  });

  it("allows under the limit", async () => {
    expect(await checkRateLimit(limiter(async () => ({ success: true, limit: 20, remaining: 19, reset: 0 })), "u")).toBeNull();
  });
});
