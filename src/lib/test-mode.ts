/**
 * Test mode: the single gate for every test-only behaviour in the web app
 * (direct Postgres driver, e2e auth bypass, fake Bedrock model, LocalStack
 * CSP entry). Nothing test-only may be enabled except through isTestMode().
 *
 * Enabled only when BOTH hold:
 *   1. CLEANSTACK_TEST_MODE is exactly "1", and
 *   2. the process is not running on a hosted platform: none of VERCEL,
 *      VERCEL_ENV, VERCEL_URL, AWS_LAMBDA_FUNCTION_NAME, AWS_EXECUTION_ENV
 *      is set. Vercel sets VERCEL=1 in every build and function, and AWS
 *      sets AWS_LAMBDA_FUNCTION_NAME in every Lambda, so a stray flag in a
 *      deployment's env is ignored (and reported by checkEnv()).
 *
 * Why not NODE_ENV=test: `next build` and `next start` always run with
 * NODE_ENV=production and Next inlines that value into the server bundle,
 * so the e2e suite (which must exercise the production build) cannot set it.
 */
import type { EnvSource } from "@/lib/env";

export const TEST_MODE_FLAG = "CLEANSTACK_TEST_MODE";

const HOSTED_MARKERS = ["VERCEL", "VERCEL_ENV", "VERCEL_URL", "AWS_LAMBDA_FUNCTION_NAME", "AWS_EXECUTION_ENV"] as const;

/** Name of the first hosted-platform marker present, if any. */
export function hostedPlatformMarker(env: EnvSource = process.env): string | null {
  for (const name of HOSTED_MARKERS) {
    const v = env[name];
    if (v !== undefined && v !== "") return name;
  }
  return null;
}

export function testModeRequested(env: EnvSource = process.env): boolean {
  return env[TEST_MODE_FLAG] === "1";
}

export function isTestMode(env: EnvSource = process.env): boolean {
  return testModeRequested(env) && hostedPlatformMarker(env) === null;
}
