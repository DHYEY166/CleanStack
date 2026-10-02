/**
 * TEST MODE ONLY: e2e sign-in / sign-out without Clerk.
 *
 * Returns 404 (as if the route did not exist) unless isTestMode() is true,
 * i.e. CLEANSTACK_TEST_MODE=1 and no Vercel/Lambda marker is present. The
 * cookie it sets is only ever read by src/lib/auth.ts and src/middleware.ts,
 * both behind the same gate.
 *
 * POST  form or JSON { user_id, redirect_url? }  -> sets the cookie
 * DELETE                                          -> clears it
 */
import { NextRequest, NextResponse } from "next/server";
import { isTestMode } from "@/lib/test-mode";
import { TEST_USER_COOKIE, isValidTestUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";

function notFound() {
  return new NextResponse("Not Found", { status: 404 });
}

/** Only same-origin relative paths, never `//host` or absolute URLs. */
function safeRedirectPath(value: unknown): string {
  return typeof value === "string" && /^\/(?![/\\])/.test(value) ? value : "/dashboard";
}

export async function POST(req: NextRequest) {
  if (!isTestMode()) return notFound();

  const isForm = (req.headers.get("content-type") ?? "").includes("form");
  let userId: unknown;
  let redirectUrl: unknown;
  if (isForm) {
    const form = await req.formData();
    userId = form.get("user_id");
    redirectUrl = form.get("redirect_url");
  } else {
    const body = await req.json().catch(() => ({}));
    userId = body?.user_id;
    redirectUrl = body?.redirect_url;
  }
  if (!isValidTestUserId(userId)) {
    return NextResponse.json({ error: "user_id must match user_test_[A-Za-z0-9_-]{1,64}" }, { status: 400 });
  }

  const res = isForm
    ? NextResponse.redirect(new URL(safeRedirectPath(redirectUrl), req.url), 303)
    : NextResponse.json({ ok: true, user_id: userId });
  res.cookies.set(TEST_USER_COOKIE, userId, { httpOnly: true, sameSite: "lax", path: "/" });
  return res;
}

export async function DELETE() {
  if (!isTestMode()) return notFound();
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(TEST_USER_COOKIE);
  return res;
}

export async function GET() {
  return notFound();
}
