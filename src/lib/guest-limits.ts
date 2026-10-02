/**
 * Guest tier. Derived from the Free plan (src/lib/billing.ts: 50,000 rows/month,
 * src/lib/rate-limit.ts: 20 uploads/h, 50 AI calls/h, src/lib/bedrock-meter.ts:
 * $50 soft / $200 hard AI spend per month) and scaled down for an anonymous
 * 24-hour trial. Caps that protect money are counted in Postgres, so they hold
 * even when Upstash is unavailable (the rate limiter fails open).
 */
import { GUEST_MAX_UPLOAD_BYTES } from "@/lib/upload-limits";

export const GUEST_LIMITS = {
  /** Per file (also enforced by the S3 POST policy and the profiler). */
  maxUploadBytes: GUEST_MAX_UPLOAD_BYTES,
  /** Rows in one uploaded file; checked after profiling, before any AI call. */
  rowsPerRun: 5_000,
  /** Rows across all of a guest's uploads (first passes). */
  rowsPerGuest: 10_000,
  /** First-pass uploads per guest (a guest lives 24 h). Sample data counts. */
  uploadsPerGuest: 3,
  /** First-pass uploads per IP per 24 h, across all guests from that IP. */
  uploadsPerIpPerDay: 10,
  /** Pipelines a guest can create. */
  pipelinesPerGuest: 5,
  /** Bedrock calls per guest per rolling hour (bedrock_usage rows). */
  aiCallsPerHour: 10,
  /** Estimated Bedrock spend per guest, lifetime. */
  aiSpendPerGuestUsd: 0.25,
  /** Estimated Bedrock spend of ALL guests together since 00:00 UTC. */
  aiSpendAllGuestsPerDayUsd: 5,
  /** New guest sessions per IP per 24 h. */
  guestsPerIpPerDay: 5,
  /** New guest sessions per 24 h, all IPs. */
  guestsPerDay: 200,
} as const;

/**
 * Features a guest cannot use: they cost money with no row/AI accounting
 * (chat builder, synthetic data, auto-clean's unattended passes), send data
 * elsewhere (Slack alerts, training export), are irreversible account actions
 * (deletion; a guest session simply expires), or are shared/admin surfaces
 * (templates, /api/admin). The middleware answers 403 (API) or redirects
 * (pages) for these, and each route also refuses guest ids (forbidGuest).
 */
export const GUEST_BLOCKED_PATHS: readonly RegExp[] = [
  /^\/api\/chat-builder(\/|$)/,
  /^\/api\/runs\/[^/]+\/auto-clean\/?$/,
  /^\/api\/export-training(\/|$)/,
  /^\/api\/alerts(\/|$)/,
  /^\/api\/account(\/|$)/,
  /^\/api\/templates(\/|$)/,
  /^\/api\/admin(\/|$)/,
  /^\/templates(\/|$)/,
];

export function isGuestBlockedPath(pathname: string): boolean {
  return GUEST_BLOCKED_PATHS.some((re) => re.test(pathname));
}

export const GUEST_BLOCKED_MESSAGE = "This feature is not available in guest mode. Sign up to use it.";
