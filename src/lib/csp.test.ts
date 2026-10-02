import { describe, expect, it } from "vitest";
import { buildCsp } from "@/lib/csp";

// The exact policy shipped before the CSP moved out of next.config.ts.
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://clerk.com https://*.clerk.accounts.dev https://js.sentry-cdn.com https://*.sentry.io",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://*.sentry.io https://*.ingest.sentry.io https://*.clerk.accounts.dev https://*.clerk.com wss://*.clerk.accounts.dev https://sqs.us-east-1.amazonaws.com https://*.s3.amazonaws.com https://*.s3.us-east-1.amazonaws.com",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "upgrade-insecure-requests",
].join("; ");

describe("buildCsp", () => {
  it("is byte-identical to the previous production policy without the test flag", () => {
    expect(buildCsp({})).toBe(PRODUCTION_CSP);
  });

  it("never allows LocalStack or drops upgrade-insecure-requests on Vercel, even with the flag", () => {
    expect(buildCsp({ CLEANSTACK_TEST_MODE: "1", VERCEL: "1" })).toBe(PRODUCTION_CSP);
  });

  it("allows LocalStack over http only in test mode", () => {
    const csp = buildCsp({ CLEANSTACK_TEST_MODE: "1" });
    expect(csp).toContain("http://*.s3.localhost.localstack.cloud:4566");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });

  it("allows Cloudflare Turnstile only when its site key is set", () => {
    const csp = buildCsp({ NEXT_PUBLIC_TURNSTILE_SITE_KEY: "0x4AAAAAAA" });
    expect(csp).toContain("frame-src https://challenges.cloudflare.com");
    expect(csp).toMatch(/script-src [^;]* https:\/\/challenges\.cloudflare\.com(;|$)/);
    expect(csp.replace(" https://challenges.cloudflare.com", "").replace("frame-src https://challenges.cloudflare.com", "frame-src 'none'")).toBe(PRODUCTION_CSP);
    expect(buildCsp({})).not.toContain("cloudflare");
  });
});
