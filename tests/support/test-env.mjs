// Environment for the integration and e2e suites. Single source of truth for
// the vitest integration config, the Playwright config, the services setup
// script and (mirrored) lambdas/tests/integration/conftest.py.
//
// Every value points at local containers: Postgres on :5432 and LocalStack
// (S3 + SQS) on :4566. *.localhost.localstack.cloud resolves to 127.0.0.1 in
// public DNS, which lets S3 use virtual-hosted URLs (needed for presigned
// URLs a browser can use). Any variable already set in the environment wins,
// so CI or a developer can point the suites elsewhere.

const LOCALSTACK = process.env.LOCALSTACK_URL ?? "http://localhost.localstack.cloud:4566";

export const TEST_ENV_DEFAULTS = {
  // Test-only switches (src/lib/test-mode.ts)
  CLEANSTACK_TEST_MODE: "1",
  DB_DRIVER: "pg",
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/cleanstack",

  // LocalStack, never real AWS
  AWS_REGION: "us-east-1",
  AWS_DEFAULT_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
  AWS_ENDPOINT_URL: LOCALSTACK,
  AWS_ENDPOINT_URL_S3: "http://s3.localhost.localstack.cloud:4566",
  S3_RAW_BUCKET: "cleanstack-test-raw",
  S3_PROCESSED_BUCKET: "cleanstack-test-processed",
  SQS_QUEUE_URL: `${LOCALSTACK}/000000000000/cleanstack-test-executor`,
  RAW_EVENTS_QUEUE_URL: `${LOCALSTACK}/000000000000/cleanstack-test-raw-events`,

  // App wiring
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  APP_URL: "http://localhost:3000",
  WEBHOOK_SECRET: "test-webhook-secret-0123456789abcdef0123",
  CRON_SECRET: "test-cron-secret-0123456789abcdef01234567",
  // Enables guest access (src/lib/guest.ts) in the suites.
  GUEST_COOKIE_SECRET: "test-guest-cookie-secret-0123456789abcdef",
  // Never used with DB_DRIVER=pg; set so requireEnv-style config checks pass.
  AURORA_CLUSTER_ARN: "arn:aws:rds:us-east-1:000000000000:cluster:unused-in-tests",
  AURORA_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:000000000000:secret:unused-in-tests",
};

/** TEST_ENV_DEFAULTS overlaid with anything already set in process.env. */
export function testEnv(overrides = {}) {
  const env = { ...TEST_ENV_DEFAULTS };
  for (const key of Object.keys(env)) {
    if (process.env[key] !== undefined && process.env[key] !== "") env[key] = process.env[key];
  }
  return { ...env, ...overrides };
}
