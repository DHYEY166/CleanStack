import { Redis } from "@upstash/redis";
import { checkQuota, type QuotaResult } from "@/lib/billing";

// Upstash Redis — HTTP-based, works from Vercel without VPC
// Falls back to direct DB if Redis unavailable
let redis: Redis | null = null;
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
} catch {
  // Redis unavailable — will fall back to DB
}

const QUOTA_TTL = 60; // seconds

export async function getCachedQuota(
  teamId: string,
  email?: string | null
): Promise<QuotaResult> {
  if (!redis) return checkQuota(teamId, email);

  const key = `quota:${teamId}`;
  try {
    const cached = await redis.get<QuotaResult>(key);
    if (cached) return cached;
  } catch {
    // Redis error — fall through to DB
  }

  const result = await checkQuota(teamId, email);

  try {
    await redis.setex(key, QUOTA_TTL, JSON.stringify(result));
  } catch {
    // Cache write failed — fine, just return the result
  }

  return result;
}

export async function invalidateQuotaCache(teamId: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(`quota:${teamId}`);
  } catch {
    // Ignore
  }
}
