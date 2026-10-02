import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { isTestMode } from "@/lib/test-mode";
import { GUEST_COOKIE, guestFromCookie } from "@/lib/guest";
import { GUEST_BLOCKED_MESSAGE, isGuestBlockedPath } from "@/lib/guest-limits";

const isProtectedRoute = createRouteMatcher([
  "/dashboard(.*)",
  "/pipelines(.*)",
  "/api/upload(.*)",
  "/api/approve-rules(.*)",
  "/api/run-status(.*)",
  "/api/templates(.*)",
  "/api/alerts(.*)",
  "/api/chat-builder(.*)",
  "/api/download(.*)",
  "/api/pipelines(.*)",
  "/api/usage(.*)",
  "/api/runs(.*)",
  "/api/export-training(.*)",
  "/api/account(.*)",
]);

const isRootPath = createRouteMatcher(["/"]);

/** A valid signed guest cookie (src/lib/guest.ts); always false when guest access is off. */
async function hasGuestSession(req: NextRequest): Promise<boolean> {
  return (await guestFromCookie(req.cookies.get(GUEST_COOKIE)?.value)) !== null;
}

/** A guest on a feature guests cannot use: 403 JSON for the API, back to the dashboard for pages. */
function guestBlocked(req: NextRequest): NextResponse {
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: GUEST_BLOCKED_MESSAGE, guest: true }, { status: 403 });
  }
  return NextResponse.redirect(new URL("/dashboard?guest_blocked=1", req.url));
}

const clerkHandler = clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req) || isGuestBlockedPath(req.nextUrl.pathname)) {
    // Clerk users first; otherwise a guest may pass (except blocked features),
    // otherwise Clerk's normal redirect / 401.
    const { userId } = await auth();
    if (userId) return;
    if (await hasGuestSession(req)) {
      if (isGuestBlockedPath(req.nextUrl.pathname)) return guestBlocked(req);
      return;
    }
    if (isProtectedRoute(req)) await auth.protect();
    return;
  }

  // Redirect authenticated users (and guests) from landing page → dashboard
  if (isRootPath(req)) {
    const { userId } = await auth();
    if (userId || (await hasGuestSession(req))) {
      return NextResponse.redirect(new URL("/dashboard", req.url));
    }
  }
});

/**
 * TEST MODE ONLY (src/lib/test-mode.ts): Clerk cannot run without real keys,
 * so e2e uses the cs_test_user cookie set by /api/test-auth. Same protected
 * routes and landing redirect as the Clerk path; unauthenticated page
 * requests go to /sign-in and API requests get 401.
 */
const TEST_USER_COOKIE = "cs_test_user"; // keep in sync with src/lib/auth.ts
const TEST_USER_ID = /^user_test_[A-Za-z0-9_-]{1,64}$/;

async function testModeMiddleware(req: NextRequest) {
  const userId = req.cookies.get(TEST_USER_COOKIE)?.value;
  const testUser = userId !== undefined && TEST_USER_ID.test(userId);
  const guest = !testUser && (await hasGuestSession(req));
  const signedIn = testUser || guest;
  if (guest && isGuestBlockedPath(req.nextUrl.pathname)) return guestBlocked(req);
  if (isProtectedRoute(req) && !signedIn) {
    if (req.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const signIn = new URL("/sign-in", req.url);
    signIn.searchParams.set("redirect_url", req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(signIn);
  }
  if (isRootPath(req) && signedIn) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }
  return NextResponse.next();
}

export default function middleware(req: NextRequest, event: NextFetchEvent) {
  if (isTestMode()) return testModeMiddleware(req);
  return clerkHandler(req, event);
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
