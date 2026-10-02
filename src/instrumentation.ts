export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
    // Report configuration problems once per server start. Logged, never
    // thrown: `next build` and preview deployments run without production
    // secrets, and each route still fails closed via requireEnv().
    const { checkEnv } = await import("./lib/env");
    const { logger } = await import("./lib/logger");
    const { errors, warnings } = checkEnv();
    if (errors.length) logger.error("invalid or missing environment", { component: "config", errors });
    if (warnings.length) logger.warn("configuration warnings", { component: "config", warnings });
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

export const onRequestError = async (...args: Parameters<typeof import("@sentry/nextjs").captureRequestError>) => {
  const { captureRequestError } = await import("@sentry/nextjs");
  captureRequestError(...args);
};
