/**
 * Upload size limits, enforced in three places:
 *   1. /api/upload refuses a declared size over the limit (413),
 *   2. the presigned POST policy carries content-length-range, so S3 itself
 *      rejects a larger body (EntityTooLarge), and
 *   3. the profiler Lambda checks ContentLength before reading the object
 *      (lambdas/profiler/handler.py, same numbers: keep in sync).
 */
import { isGuestId } from "@/lib/guest";

export const MB = 1024 * 1024;
/** Default per-file limit for signed-in users; override with MAX_UPLOAD_MB. */
export const DEFAULT_MAX_UPLOAD_MB = 100;
/** Guests (src/lib/guest.ts). */
export const GUEST_MAX_UPLOAD_BYTES = 2 * MB;

export function userMaxUploadBytes(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const mb = Number(env.MAX_UPLOAD_MB);
  return Number.isFinite(mb) && mb > 0 ? Math.floor(mb * MB) : DEFAULT_MAX_UPLOAD_MB * MB;
}

export function maxUploadBytesFor(teamId: string, env: Readonly<Record<string, string | undefined>> = process.env): number {
  return isGuestId(teamId) ? GUEST_MAX_UPLOAD_BYTES : userMaxUploadBytes(env);
}

export function formatMb(bytes: number): string {
  const mb = bytes / MB;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}
