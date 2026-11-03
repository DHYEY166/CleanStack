import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
  replaysSessionSampleRate: 0.01,
  integrations: [Sentry.replayIntegration()],
  // Only capture errors from the app's own origin (NEXT_PUBLIC_APP_URL) — prevents DSN abuse
  allowUrls: [
    ...(process.env.NEXT_PUBLIC_APP_URL ? [process.env.NEXT_PUBLIC_APP_URL] : []),
    /http:\/\/localhost/,
  ],
});
