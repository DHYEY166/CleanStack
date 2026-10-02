// Integration suite: real Postgres + LocalStack, route handlers in-process,
// Lambda handlers via tests/support/invoke_lambda.py. Needs the services:
//   docker compose -f tests/support/docker-compose.yml up -d --wait
//   node tests/support/setup-services.mjs
//   npm run test:integration
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { testEnv } from "./tests/support/test-env.mjs";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    env: testEnv(),
    globalSetup: ["tests/integration/global-setup.ts"],
    // Files share the queues; run them one at a time.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
