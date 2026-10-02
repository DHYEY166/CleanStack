/**
 * Route-level guest checks (server only). The middleware already blocks the
 * paths in GUEST_BLOCKED_PATHS; routes call forbidGuest() too so a matcher
 * mistake cannot expose a feature.
 */
import { NextResponse } from "next/server";
import { isGuestId } from "@/lib/guest";
import { GUEST_BLOCKED_MESSAGE } from "@/lib/guest-limits";

export function guestForbiddenResponse(): NextResponse {
  return NextResponse.json({ error: GUEST_BLOCKED_MESSAGE, guest: true }, { status: 403 });
}

/** 403 for a guest id, null otherwise. */
export function forbidGuest(userId: string | null | undefined): NextResponse | null {
  return userId && isGuestId(userId) ? guestForbiddenResponse() : null;
}
