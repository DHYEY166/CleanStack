export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
    // Report configuration problems once per server start. Logged, never
    // thrown: `next build` and preview deployments run without production
    // secrets, and each route still fails closed via requireEnv().
    const { checkEnv } = await import("./lib/env");
    const { errors, warnings } = checkEnv();
    if (errors.length) console.error("[config] invalid or missing environment:", errors.join("; "));
    if (warnings.length) console.warn("[config] warnings:", warnings.join("; "));
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

export const onRequestError = async (...args: Parameters<typeof import("@sentry/nextjs").captureRequestError>) => {
  const { captureRequestError } = await import("@sentry/nextjs");
  captureRequestError(...args);
};
