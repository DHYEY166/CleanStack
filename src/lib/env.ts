/**
 * Server configuration contract: every environment variable the Next.js app
 * reads, whether it is required, and how it is validated.
 *
 * - `requireEnv(name)` returns the value or throws a ConfigError that names
 *   the variable, instead of failing later as an opaque AWS SDK error such as
 *   `Bucket: undefined`.
 * - `optionalEnv(name)` returns undefined when unset (still validated if set).
 * - `checkEnv()` powers the startup report in src/instrumentation.ts. It only
 *   logs; it never throws, so `next build` and preview deploys without the
 *   full set of secrets still work.
 *
 * Keep in sync with .env.example and the README configuration table.
 */

import { hostedPlatformMarker } from "@/lib/test-mode";

type Validator = (value: string) => string | null; // null = ok, otherwise reason

const nonEmpty: Validator = () => null;
const arn: Validator = (v) => (/^arn:aws[a-z-]*:/.test(v) ? null : "must be an AWS ARN");
const httpsUrl: Validator = (v) => {
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? null : "must be an http(s) URL";
  } catch {
    return "must be a URL";
  }
};

interface EnvSpec {
  validate: Validator;
  /** Reported as an error at startup when missing. */
  required: boolean;
  fallback?: string;
  /** Shared secrets: warn (not fail) below this length. */
  minSecretLength?: number;
  description: string;
}

export const ENV_SPEC = {
  AWS_REGION: { validate: nonEmpty, required: false, fallback: "us-east-1", description: "AWS region for S3, SQS, RDS Data API and Bedrock" },
  AURORA_CLUSTER_ARN: { validate: arn, required: true, description: "Aurora Serverless v2 cluster ARN (RDS Data API)" },
  AURORA_SECRET_ARN: { validate: arn, required: true, description: "Secrets Manager ARN with the database credentials" },
  S3_RAW_BUCKET: { validate: nonEmpty, required: true, description: "Bucket for raw uploads" },
  S3_PROCESSED_BUCKET: { validate: nonEmpty, required: true, description: "Bucket for cleaned deliverables and audit files" },
  SQS_QUEUE_URL: { validate: httpsUrl, required: true, description: "Executor queue; without it approved runs complete without executing" },
  AI_QUEUE_ENABLED: { validate: nonEmpty, required: false, description: '"true" to enqueue AI suggestion jobs instead of calling suggest-transforms inline' },
  AI_JOBS_QUEUE_URL: { validate: httpsUrl, required: false, description: "AI jobs queue (required when AI_QUEUE_ENABLED=true)" },
  NEXT_PUBLIC_APP_URL: { validate: httpsUrl, required: true, description: "Public base URL used for internal webhook calls" },
  WEBHOOK_SECRET: { validate: nonEmpty, required: true, minSecretLength: 32, description: "Shared secret between the Lambdas and the webhook routes" },
  CRON_SECRET: { validate: nonEmpty, required: true, minSecretLength: 32, description: "Bearer secret for /api/cron/* (Vercel Cron)" },
  ADMIN_SECRET: { validate: nonEmpty, required: false, minSecretLength: 32, description: "x-admin-secret for /api/admin/*; admin routes are disabled when unset" },
  ADMIN_EMAILS: { validate: nonEmpty, required: false, description: "Comma-separated emails treated as admins (billing bypass)" },
  ADMIN_USER_IDS: { validate: nonEmpty, required: false, description: "Comma-separated Clerk user ids treated as admins" },
  UPSTASH_REDIS_REST_URL: { validate: httpsUrl, required: false, description: "Upstash Redis for rate limiting and quota cache (both disabled when unset)" },
  UPSTASH_REDIS_REST_TOKEN: { validate: nonEmpty, required: false, description: "Upstash Redis token" },
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: { validate: nonEmpty, required: true, description: "Clerk publishable key (read by @clerk/nextjs)" },
  CLERK_SECRET_KEY: { validate: nonEmpty, required: true, description: "Clerk secret key (read by @clerk/nextjs)" },
  LOG_LEVEL: { validate: (v) => (["debug", "info", "warn", "error"].includes(v) ? null : "must be debug|info|warn|error"), required: false, description: "Structured logger threshold (default info)" },
  // Test-only (honoured only when src/lib/test-mode.ts isTestMode() is true)
  CLEANSTACK_TEST_MODE: { validate: (v) => (v === "1" || v === "0" ? null : 'must be "1" or "0"'), required: false, description: "TEST ONLY: enables the test-only switches; ignored on Vercel/Lambda" },
  DB_DRIVER: { validate: (v) => (v === "data-api" || v === "pg" ? null : "must be data-api or pg"), required: false, description: 'TEST ONLY: "pg" = direct Postgres via DATABASE_URL (default data-api)' },
  DATABASE_URL: { validate: nonEmpty, required: false, description: "TEST ONLY for the web app (DB_DRIVER=pg); also used by run-migration.mjs" },
  SENTRY_DSN: { validate: httpsUrl, required: false, description: "Server/edge Sentry DSN" },
  NEXT_PUBLIC_SENTRY_DSN: { validate: httpsUrl, required: false, description: "Browser Sentry DSN" },
} satisfies Record<string, EnvSpec>;

export type EnvName = keyof typeof ENV_SPEC;

/** Any string map; defaults to process.env. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function read(name: EnvName, source: EnvSource): string | undefined {
  const raw = source[name];
  if (raw === undefined || raw.trim() === "") return (ENV_SPEC[name] as EnvSpec).fallback;
  return raw.trim();
}

/** Return the validated value of `name`, or throw ConfigError naming the variable. */
export function requireEnv(name: EnvName, source: EnvSource = process.env): string {
  const value = read(name, source);
  if (value === undefined) throw new ConfigError(`Configuration error: ${name} is not set`);
  const problem = (ENV_SPEC[name] as EnvSpec).validate(value);
  if (problem) throw new ConfigError(`Configuration error: ${name} ${problem}`);
  return value;
}

/** Return the validated value of a variable, or undefined when it is unset. */
export function optionalEnv(name: EnvName, source: EnvSource = process.env): string | undefined {
  return read(name, source) === undefined ? undefined : requireEnv(name, source);
}

/** AWS region for SDK clients; never throws so module-level clients can be built at import time. */
export function awsRegion(source: EnvSource = process.env): string {
  return read("AWS_REGION", source) ?? "us-east-1";
}

export interface EnvReport {
  errors: string[];
  warnings: string[];
}

/** Missing/invalid required variables (errors) and weak or inconsistent settings (warnings). */
export function checkEnv(source: EnvSource = process.env): EnvReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const name of Object.keys(ENV_SPEC) as EnvName[]) {
    const spec: EnvSpec = ENV_SPEC[name];
    const value = read(name, source);
    if (value === undefined) {
      if (spec.required) errors.push(`${name} is not set`);
      continue;
    }
    const problem = spec.validate(value);
    if (problem) {
      (spec.required ? errors : warnings).push(`${name} ${problem}`);
      continue;
    }
    if (spec.minSecretLength && value.length < spec.minSecretLength) {
      warnings.push(`${name} is shorter than ${spec.minSecretLength} characters`);
    }
  }
  const testFlag = read("CLEANSTACK_TEST_MODE", source) === "1";
  const hosted = hostedPlatformMarker(source);
  if (testFlag && hosted) {
    errors.push(`CLEANSTACK_TEST_MODE=1 is set on a hosted platform (${hosted}); it is ignored there. Remove it.`);
  } else if (testFlag) {
    warnings.push("TEST MODE ENABLED: auth bypass, fake Bedrock and test DB driver are active. Never use outside tests.");
  }
  if (read("DB_DRIVER", source) === "pg" && !(testFlag && !hosted)) {
    errors.push("DB_DRIVER=pg is only allowed in test mode; the app will refuse to query.");
  }
  if (read("AI_QUEUE_ENABLED", source) === "true" && read("AI_JOBS_QUEUE_URL", source) === undefined) {
    errors.push("AI_JOBS_QUEUE_URL is not set but AI_QUEUE_ENABLED=true");
  }
  const hasRedisUrl = read("UPSTASH_REDIS_REST_URL", source) !== undefined;
  const hasRedisToken = read("UPSTASH_REDIS_REST_TOKEN", source) !== undefined;
  if (hasRedisUrl !== hasRedisToken) {
    warnings.push("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set together; rate limiting is off");
  } else if (!hasRedisUrl) {
    warnings.push("Upstash Redis not configured; rate limiting and quota cache are off");
  }
  return { errors, warnings };
}
