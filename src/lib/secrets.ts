import { createHash, timingSafeEqual } from "crypto";

/**
 * Constant-time comparison for shared secrets (webhook, admin, cron).
 *
 * Both values are hashed first so the comparison does not leak the secret's
 * length, and an empty expected value never matches - a missing env var must
 * fail closed rather than accept an empty header.
 */
export function safeCompare(provided: string, expected: string): boolean {
  if (!expected) return false;
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
