/**
 * Guest access: try CleanStack without an account.
 *
 * A guest is a random id `guest_<22 base64url chars>` (128 bits) that is used
 * as `team_id` everywhere a Clerk user id would be, so every existing
 * `team_id = $userId` query and the `${userId}/` S3 prefix scope guest data
 * exactly like a user's. The id lives in the `cs_guest` cookie as
 * `<id>.<expires unix s>.<HMAC-SHA256(GUEST_COOKIE_SECRET, "<id>.<exp>")>`:
 * httpOnly, SameSite=Lax, Secure outside test mode, 24 h. It cannot be forged
 * or extended without the secret.
 *
 * Guest access is OFF unless GUEST_COOKIE_SECRET is set (>= 32 chars): no
 * cookie is issued and any cookie is ignored. Edge-safe (Web Crypto only), so
 * src/middleware.ts can verify the cookie too.
 */
import type { EnvSource } from "@/lib/env";

export const GUEST_COOKIE = "cs_guest";
export const GUEST_ID_PREFIX = "guest_";
export const GUEST_TTL_SECONDS = 24 * 60 * 60;
const GUEST_ID = /^guest_[A-Za-z0-9_-]{22}$/;
const MIN_SECRET_LENGTH = 32;

export interface GuestSession {
  guestId: string;
  /** Unix seconds. */
  expiresAt: number;
}

export function isGuestId(id: unknown): id is string {
  return typeof id === "string" && GUEST_ID.test(id);
}

/** The signing secret, or null when guest access is disabled. */
export function guestSecret(env: EnvSource = process.env): string | null {
  const s = env.GUEST_COOKIE_SECRET?.trim();
  return s && s.length >= MIN_SECRET_LENGTH ? s : null;
}

export function guestAccessEnabled(env: EnvSource = process.env): boolean {
  return guestSecret(env) !== null;
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function newGuestId(): string {
  return GUEST_ID_PREFIX + base64url(crypto.getRandomValues(new Uint8Array(16)));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signGuestToken(session: GuestSession, secret: string): Promise<string> {
  const payload = `${session.guestId}.${session.expiresAt}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(payload));
  return `${payload}.${base64url(new Uint8Array(sig))}`;
}

/** The session in a cookie value, or null if malformed, tampered with, or expired. */
export async function verifyGuestToken(
  token: string | undefined | null,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<GuestSession | null> {
  if (!token || token.length > 200) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [guestId, expRaw, sigRaw] = parts;
  if (!isGuestId(guestId) || !/^\d{1,12}$/.test(expRaw)) return null;
  const expiresAt = Number(expRaw);
  if (expiresAt <= nowSeconds || expiresAt > nowSeconds + GUEST_TTL_SECONDS + 60) return null;
  const sig = fromBase64url(sigRaw);
  if (!sig) return null;
  // crypto.subtle.verify compares in constant time.
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), sig as BufferSource, new TextEncoder().encode(`${guestId}.${expRaw}`));
  return ok ? { guestId, expiresAt } : null;
}

/** Verify a cookie value with GUEST_COOKIE_SECRET; null when guest access is off. */
export async function guestFromCookie(value: string | undefined | null, env: EnvSource = process.env): Promise<GuestSession | null> {
  const secret = guestSecret(env);
  if (!secret) return null;
  return verifyGuestToken(value, secret);
}

/** Cookie attributes for the guest cookie. `secure` is false only for plain-http test servers. */
export function guestCookieOptions(expiresAt: number, secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    expires: new Date(expiresAt * 1000),
  };
}

/**
 * Client IP for per-IP caps: the first X-Forwarded-For hop (Vercel sets it and
 * strips client-supplied values), then X-Real-IP. "unknown" if neither.
 */
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff || headers.get("x-real-ip")?.trim() || "unknown";
}

/** HMAC of the IP so raw addresses are never stored. */
export async function hashIp(ip: string, secret: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(`ip:${secret}`), new TextEncoder().encode(ip));
  return base64url(new Uint8Array(sig));
}
