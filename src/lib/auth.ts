/**
 * Server-side auth facade. Every server component and route handler gets the
 * signed-in user through this module instead of importing @clerk/nextjs/server
 * directly, so the e2e suite can sign in without real Clerk keys.
 *
 * Production (isTestMode() false): thin pass-through to Clerk's auth(),
 * currentUser() and clerkClient(). Behaviour is unchanged.
 *
 * TEST MODE ONLY (see src/lib/test-mode.ts): the user id comes from the
 * `cs_test_user` cookie set by POST /api/test-auth. That route answers 404
 * outside test mode, and this module ignores the cookie outside test mode, so
 * the bypass cannot be used in a deployment even if the cookie is forged:
 * isTestMode() is false whenever VERCEL / AWS Lambda markers are present.
 *
 * Guests (src/lib/guest.ts): when there is no Clerk (or test) user, a valid
 * signed `cs_guest` cookie makes `auth()` return the guest id (`guest_...`),
 * which is then used as team_id like any user id. Guests have no email.
 * Without GUEST_COOKIE_SECRET guest cookies are ignored.
 */
import { auth as clerkAuth, currentUser as clerkCurrentUser, clerkClient } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { isTestMode } from "@/lib/test-mode";
import { GUEST_COOKIE, guestFromCookie, isGuestId } from "@/lib/guest";

export { isGuestId } from "@/lib/guest";

export const TEST_USER_COOKIE = "cs_test_user";

/** Accepted test user ids: `user_test_` + 1..64 safe chars. */
const TEST_USER_ID = /^user_test_[A-Za-z0-9_-]{1,64}$/;

export function isValidTestUserId(value: unknown): value is string {
  return typeof value === "string" && TEST_USER_ID.test(value);
}

/** Deterministic email for a test user (quota and billing look users up by email). */
export function testUserEmail(userId: string): string {
  return `${userId.toLowerCase()}@e2e.cleanstack.test`;
}

async function testUserId(): Promise<string | null> {
  const value = (await cookies()).get(TEST_USER_COOKIE)?.value;
  return isValidTestUserId(value) ? value : null;
}

async function guestUserId(): Promise<string | null> {
  const session = await guestFromCookie((await cookies()).get(GUEST_COOKIE)?.value);
  return session?.guestId ?? null;
}

/** `{ userId }` of the signed-in user or guest (`guest_...`), or `{ userId: null }`. */
export async function auth(): Promise<{ userId: string | null }> {
  if (isTestMode()) return { userId: (await testUserId()) ?? (await guestUserId()) };
  const { userId } = await clerkAuth();
  return { userId: userId ?? (await guestUserId()) };
}

/** Primary email of the signed-in user, or null (always null for guests). */
export async function currentUserEmail(): Promise<string | null> {
  if (isTestMode()) {
    const id = await testUserId();
    return id ? testUserEmail(id) : null;
  }
  const user = await clerkCurrentUser();
  return user?.primaryEmailAddress?.emailAddress ?? null;
}

/** First email address of any user by id (used by webhook-driven routes), or null. Guests have none. */
export async function userEmailById(userId: string): Promise<string | null> {
  if (isGuestId(userId)) return null;
  if (isTestMode()) return isValidTestUserId(userId) ? testUserEmail(userId) : null;
  const clerk = await clerkClient();
  const user = await clerk.users.getUser(userId).catch(() => null);
  return user?.emailAddresses?.[0]?.emailAddress ?? null;
}
