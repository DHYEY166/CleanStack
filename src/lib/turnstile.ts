/**
 * Optional Cloudflare Turnstile check for guest sign-up. Active only when
 * TURNSTILE_SECRET_KEY is set (the widget needs NEXT_PUBLIC_TURNSTILE_SITE_KEY).
 */
import { optionalEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

const log = logger.child({ component: "turnstile" });
const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function turnstileEnabled(): boolean {
  return optionalEnv("TURNSTILE_SECRET_KEY") !== undefined;
}

/** true when Turnstile is off, or the token verifies. Fails closed on network errors. */
export async function verifyTurnstile(token: unknown, ip: string): Promise<boolean> {
  const secret = optionalEnv("TURNSTILE_SECRET_KEY");
  if (!secret) return true;
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip !== "unknown") body.set("remoteip", ip);
    const res = await fetch(VERIFY_URL, { method: "POST", body, signal: AbortSignal.timeout(5000) });
    const data = (await res.json().catch(() => ({}))) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    log.warn("Turnstile verification failed; refusing guest session", { err });
    return false;
  }
}
