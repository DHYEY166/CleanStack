import { describe, expect, it } from "vitest";
import {
  GUEST_TTL_SECONDS, clientIp, guestAccessEnabled, guestFromCookie, hashIp, isGuestId, newGuestId, signGuestToken, verifyGuestToken,
} from "@/lib/guest";

const SECRET = "unit-test-guest-secret-0123456789abcdef";
const now = 1_800_000_000;

describe("guest ids", () => {
  it("are guest_ + 22 base64url chars (128 random bits) and unique", () => {
    const ids = new Set(Array.from({ length: 200 }, newGuestId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(isGuestId(id)).toBe(true);
  });

  it.each([["guest_", false], ["guest_" + "a".repeat(21), false], ["guest_" + "a".repeat(23), false],
    ["user_" + "a".repeat(22), false], ["guest_" + "a".repeat(21) + "/", false], [null, false]])("%s -> %s", (v, ok) => {
    expect(isGuestId(v)).toBe(ok);
  });
});

describe("guest tokens", () => {
  const session = { guestId: "guest_AAAAAAAAAAAAAAAAAAAAAA", expiresAt: now + 3600 };

  it("round-trip", async () => {
    const token = await signGuestToken(session, SECRET);
    expect(await verifyGuestToken(token, SECRET, now)).toEqual(session);
  });

  it("reject another secret, tampering, expiry and over-long lifetimes", async () => {
    const token = await signGuestToken(session, SECRET);
    expect(await verifyGuestToken(token, SECRET + "x", now)).toBeNull();
    const [id, exp, sig] = token.split(".");
    expect(await verifyGuestToken(`guest_BAAAAAAAAAAAAAAAAAAAAA.${exp}.${sig}`, SECRET, now)).toBeNull();
    expect(await verifyGuestToken(`${id}.${Number(exp) + 1}.${sig}`, SECRET, now)).toBeNull();
    expect(await verifyGuestToken(`${id}.${exp}.${sig.slice(0, -2)}AA`, SECRET, now)).toBeNull();
    expect(await verifyGuestToken(token, SECRET, now + 3600)).toBeNull();
    const tooLong = await signGuestToken({ ...session, expiresAt: now + GUEST_TTL_SECONDS + 3600 }, SECRET);
    expect(await verifyGuestToken(tooLong, SECRET, now)).toBeNull();
    for (const junk of ["", "a.b", "a.b.c.d", `${id}.${exp}.!!!`, "x".repeat(500)]) {
      expect(await verifyGuestToken(junk, SECRET, now)).toBeNull();
    }
  });

  it("guest access is off without a secret of at least 32 chars", async () => {
    const token = await signGuestToken({ ...session, expiresAt: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    expect(guestAccessEnabled({})).toBe(false);
    expect(guestAccessEnabled({ GUEST_COOKIE_SECRET: "short" })).toBe(false);
    expect(await guestFromCookie(token, {})).toBeNull();
    expect(guestAccessEnabled({ GUEST_COOKIE_SECRET: SECRET })).toBe(true);
    expect(await guestFromCookie(token, { GUEST_COOKIE_SECRET: SECRET })).not.toBeNull();
  });
});

describe("client IP", () => {
  it("uses the first X-Forwarded-For hop, then X-Real-IP", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
    expect(clientIp(new Headers({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(clientIp(new Headers())).toBe("unknown");
  });

  it("is stored only as a keyed hash", async () => {
    const h = await hashIp("203.0.113.7", SECRET);
    expect(h).toBe(await hashIp("203.0.113.7", SECRET));
    expect(h).not.toBe(await hashIp("203.0.113.8", SECRET));
    expect(h).not.toContain("203");
  });
});
