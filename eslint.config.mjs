import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Server code logs through src/lib/logger.ts (structured JSON), not console.
  {
    files: ["src/app/api/**/*.ts", "src/lib/**/*.ts", "src/instrumentation.ts"],
    ignores: ["src/lib/logger.ts", "**/*.test.ts"],
    rules: { "no-console": "error" },
  },
  // Server code reads the user through src/lib/auth.ts so the test-mode
  // auth bypass has exactly one gated entry point.
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["src/lib/auth.ts", "src/middleware.ts", "**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{ name: "@clerk/nextjs/server", message: "Import auth helpers from @/lib/auth instead." }],
      }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "playwright-report/**",
    "test-results/**",
  ]),
]);

export default eslintConfig;
