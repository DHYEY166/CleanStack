/**
 * Playwright e2e: the production build (`next start`) in test mode against the
 * integration services, plus tests/e2e/lambda_worker.py running the real
 * profiler/executor handlers from LocalStack queues.
 *
 * Prerequisites (CI does the same):
 *   docker compose -f tests/support/docker-compose.yml up -d --wait
 *   node tests/support/setup-services.mjs
 *   npm run e2e:build          # next build with the test env
 *   npm run test:e2e
 *
 * Two extra servers from the same build check that the auth bypass is OFF
 * without the flag (:3101) and when the flag leaks onto Vercel (:3102).
 */
import { defineConfig, devices } from "@playwright/test";
import { testEnv } from "./tests/support/test-env.mjs";

const env = testEnv();
const python = process.env.PYTHON ?? "python3";
// Well-formed but fake Clerk keys for the guard servers (no network is needed to
// reject an unauthenticated request). Never valid credentials.
const FAKE_CLERK = {
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("example.clerk.accounts.dev$").toString("base64")}`,
  CLERK_SECRET_KEY: "sk_test_fake_e2e_guard_not_a_real_key",
};
const withoutTestMode = Object.fromEntries(Object.entries(env).filter(([k]) => k !== "CLEANSTACK_TEST_MODE" && k !== "DB_DRIVER"));

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: env.NEXT_PUBLIC_APP_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    acceptDownloads: true,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npx next start -p 3000",
      url: "http://localhost:3000/sign-in",
      env,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
    },
    {
      command: `${python} tests/e2e/lambda_worker.py`,
      wait: { stdout: /lambda worker ready/ },
      env,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
    },
    {
      command: "npx next start -p 3101",
      url: "http://localhost:3101/pricing",
      env: { ...withoutTestMode, ...FAKE_CLERK },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "npx next start -p 3102",
      url: "http://localhost:3102/pricing",
      env: { ...env, ...FAKE_CLERK, VERCEL: "1" },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
