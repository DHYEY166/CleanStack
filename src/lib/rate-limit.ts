import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Upstash Redis already configured for quota caching — reuse for rate limiting
function getRatelimiter(requests: number, window: string) {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return null; // No Redis — skip rate limiting (fail open)
  }
  return new Ratelimit({
    redis: new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    }),
    limiter: Ratelimit.slidingWindow(requests, window as Parameters<typeof Ratelimit.slidingWindow>[1]),
    analytics: false,
  });
}

// Per-user limits
export const uploadLimiter = getRatelimiter(20, "1 h");      // 20 uploads/hr per user
export const aiLimiter = getRatelimiter(50, "1 h");           // 50 AI calls/hr per user
export const chatLimiter = getRatelimiter(30, "1 h");         // 30 chat msgs/hr per user

import { NextResponse } from "next/server";

/**
 * null = allowed, otherwise a 429 response.
 *
 * Never throws. If Upstash is unreachable (DNS failure, deleted database, bad
 * token) the request is allowed and a warning is logged, the same fail-open
 * behaviour as when Redis is not configured. Before this, the Upstash REST
 * client's "TypeError: fetch failed ... getaddrinfo ENOTFOUND" escaped the
 * route handler and /api/upload answered 500 with an empty body.
 */
export async function checkRateLimit(
  limiter: Ratelimit | null,
  identifier: string
): Promise<NextResponse | null> {
  if (!limiter) return null; // Redis not configured — allow
  let result: Awaited<ReturnType<Ratelimit["limit"]>>;
  try {
    result = await limiter.limit(identifier);
  } catch (err) {
    // Fail open: an Upstash outage must not take uploads/AI routes down.
    // Quota limits (the billing control) are enforced from Postgres, so the
    // only thing lost while Redis is down is burst protection.
    const e = err as Error & { cause?: { message?: string } };
    console.warn(JSON.stringify({
      level: "warn",
      msg: "Upstash rate limiter unavailable; allowing request (check UPSTASH_REDIS_REST_URL/TOKEN)",
      component: "rate-limit",
      err: { name: e?.name, message: e?.message, cause: e?.cause?.message },
    }));
    return null;
  }
  const { success, limit, remaining, reset } = result;
  if (!success) {
    return NextResponse.json(
      { error: "Too many requests. Please wait before trying again." },
      {
        status: 429,
        headers: {
          "X-RateLimit-Limit": String(limit),
          "X-RateLimit-Remaining": String(remaining),
          "X-RateLimit-Reset": String(reset),
          "Retry-After": String(Math.ceil((reset - Date.now()) / 1000)),
        },
      }
    );
  }
  return null;
}
