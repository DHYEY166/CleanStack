/**
 * Content-Security-Policy for every response (wired in next.config.ts, which
 * evaluates it at build time).
 *
 * Allows Clerk (accounts.dev + clerk.com CDN), Sentry ingest, our own origin,
 * and S3/SQS in us-east-1. 'unsafe-inline' is required for Next.js inline
 * scripts and Clerk; a nonce-based CSP needs per-request nonces (follow-up).
 *
 * Cloudflare Turnstile (guest sign-in, src/components/Guest.tsx) adds
 * https://challenges.cloudflare.com to script-src and frame-src, only when
 * NEXT_PUBLIC_TURNSTILE_SITE_KEY is set at build time.
 *
 * TEST MODE ONLY (src/lib/test-mode.ts, evaluated against the build env): the
 * browser talks to LocalStack over plain http, so connect-src also allows the
 * LocalStack S3 origins and `upgrade-insecure-requests` is dropped. A build
 * on Vercel (VERCEL=1) never gets these, even if the test flag leaks.
 */
import { isTestMode } from "./test-mode";
import type { EnvSource } from "./env";

export const LOCALSTACK_CONNECT_SRC = [
  "http://localhost.localstack.cloud:4566",
  "http://s3.localhost.localstack.cloud:4566",
  "http://*.s3.localhost.localstack.cloud:4566",
];

export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

export function buildCsp(env: EnvSource = process.env): string {
  const test = isTestMode(env);
  const turnstile = !!env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  const connectSrc = [
    "'self'",
    "https://*.sentry.io",
    "https://*.ingest.sentry.io",
    "https://*.clerk.accounts.dev",
    "https://*.clerk.com",
    "wss://*.clerk.accounts.dev",
    "https://sqs.us-east-1.amazonaws.com",
    "https://*.s3.amazonaws.com",
    "https://*.s3.us-east-1.amazonaws.com",
    ...(test ? LOCALSTACK_CONNECT_SRC : []),
  ];
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' https://clerk.com https://*.clerk.accounts.dev https://js.sentry-cdn.com https://*.sentry.io${turnstile ? ` ${TURNSTILE_ORIGIN}` : ""}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    `connect-src ${connectSrc.join(" ")}`,
    turnstile ? `frame-src ${TURNSTILE_ORIGIN}` : "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    ...(test ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}
