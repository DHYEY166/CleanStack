import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

// CSP: allows Clerk (accounts.dev + clerk.com CDN), Sentry ingest, and our own origin.
// Note: 'unsafe-inline' required for Next.js inline scripts and Clerk. Nonce-based CSP
// would remove this but needs middleware + per-request nonce injection — post-hackathon.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://clerk.com https://*.clerk.accounts.dev https://js.sentry-cdn.com https://*.sentry.io",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://*.sentry.io https://*.ingest.sentry.io https://*.clerk.accounts.dev https://*.clerk.com wss://*.clerk.accounts.dev https://sqs.us-east-1.amazonaws.com",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "upgrade-insecure-requests",
].join("; ");

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
          { key: "Content-Security-Policy", value: CSP },
        ],
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  silent: true,
  // Skip source map upload — no SENTRY_AUTH_TOKEN configured
  sourcemaps: { disable: true },
});
