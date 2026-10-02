import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

import { buildCsp } from "./src/lib/csp";

// See src/lib/csp.ts. Evaluated at build time.
const CSP = buildCsp();

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
