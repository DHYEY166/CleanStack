/**
 * Guest sessions (src/lib/guest.ts). Answers 404 unless GUEST_COOKIE_SECRET is set.
 *
 * POST   { turnstile_token? } -> issues the signed `cs_guest` cookie (24 h).
 *        Reuses a still-valid guest cookie. 409 when signed in with an account,
 *        403 when Turnstile is enabled and the token fails, 429 when this IP
 *        already started GUEST_LIMITS.guestsPerIpPerDay sessions in 24 h, 503
 *        when GUEST_LIMITS.guestsPerDay sessions were started in 24 h overall.
 * GET    -> { enabled, guest: { expires_at } | null }
 * DELETE -> ends the session (clears the cookie; data is purged within 24 h).
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { queryOne } from "@/lib/db";
import {
  GUEST_COOKIE, GUEST_TTL_SECONDS, clientIp, guestAccessEnabled, guestCookieOptions, guestFromCookie,
  guestSecret, hashIp, isGuestId, newGuestId, signGuestToken,
} from "@/lib/guest";
import { GUEST_LIMITS } from "@/lib/guest-limits";
import { verifyTurnstile } from "@/lib/turnstile";
import { isTestMode } from "@/lib/test-mode";
import { logger } from "@/lib/logger";

const log = logger.child({ route: "/api/guest" });

export const dynamic = "force-dynamic";

const notFound = () => new NextResponse("Not Found", { status: 404 });
const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

export async function GET(req: NextRequest) {
  if (!guestAccessEnabled()) return NextResponse.json({ enabled: false, guest: null });
  // A signed-in user with a stale guest cookie is not a guest (auth() prefers Clerk).
  const { userId } = await auth().catch(() => ({ userId: null }));
  if (userId && !isGuestId(userId)) return NextResponse.json({ enabled: true, guest: null });
  const session = await guestFromCookie(req.cookies.get(GUEST_COOKIE)?.value);
  return NextResponse.json({ enabled: true, guest: session ? { expires_at: iso(session.expiresAt) } : null });
}

export async function POST(req: NextRequest) {
  const secret = guestSecret();
  if (!secret) return notFound();

  try {
    const { userId } = await auth();
    if (userId && !isGuestId(userId)) {
      return NextResponse.json({ error: "You are already signed in." }, { status: 409 });
    }
    const existing = await guestFromCookie(req.cookies.get(GUEST_COOKIE)?.value);
    if (existing) return NextResponse.json({ ok: true, expires_at: iso(existing.expiresAt), reused: true });

    const body = (await req.json().catch(() => ({}))) as { turnstile_token?: unknown };
    const ip = clientIp(req.headers);
    if (!(await verifyTurnstile(body?.turnstile_token, ip))) {
      return NextResponse.json({ error: "Verification failed. Please retry." }, { status: 403 });
    }

    const ipHash = await hashIp(ip, secret);
    const guestId = newGuestId();
    const expiresAt = Math.floor(Date.now() / 1000) + GUEST_TTL_SECONDS;

    // Caps checked and the row inserted in one statement.
    const inserted = await queryOne<{ id: string }>(
      `INSERT INTO guest_sessions (id, ip_hash, expires_at)
       SELECT $1, $2, now() + make_interval(secs => $3)
       WHERE (SELECT count(*) FROM guest_sessions
               WHERE ip_hash = $2 AND created_at > now() - interval '24 hours') < $4
         AND (SELECT count(*) FROM guest_sessions
               WHERE created_at > now() - interval '24 hours') < $5
       RETURNING id`,
      [guestId, ipHash, GUEST_TTL_SECONDS, GUEST_LIMITS.guestsPerIpPerDay, GUEST_LIMITS.guestsPerDay]
    );
    if (!inserted) {
      const perIp = await queryOne<{ n: number }>(
        "SELECT count(*)::int AS n FROM guest_sessions WHERE ip_hash = $1 AND created_at > now() - interval '24 hours'",
        [ipHash]
      );
      if (Number(perIp?.n ?? 0) >= GUEST_LIMITS.guestsPerIpPerDay) {
        log.warn("guest session refused: per-IP cap", { cap: GUEST_LIMITS.guestsPerIpPerDay });
        return NextResponse.json(
          { error: `Guest limit reached for your network (${GUEST_LIMITS.guestsPerIpPerDay} guest sessions per day). Sign up for a free account to continue.` },
          { status: 429 }
        );
      }
      log.warn("guest session refused: global cap", { cap: GUEST_LIMITS.guestsPerDay });
      return NextResponse.json(
        { error: "Guest access is at capacity today. Please sign up for a free account or try again tomorrow." },
        { status: 503 }
      );
    }

    const res = NextResponse.json({ ok: true, expires_at: iso(expiresAt) }, { status: 201 });
    res.cookies.set(GUEST_COOKIE, await signGuestToken({ guestId, expiresAt }, secret), guestCookieOptions(expiresAt, !isTestMode()));
    log.info("guest session started");
    return res;
  } catch (err) {
    log.error("guest session failed", { err });
    return NextResponse.json({ error: "Could not start a guest session. Please retry." }, { status: 500 });
  }
}

export async function DELETE() {
  if (!guestAccessEnabled()) return notFound();
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(GUEST_COOKIE);
  return res;
}
