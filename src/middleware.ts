import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isProtectedRoute = createRouteMatcher([
  "/dashboard(.*)",
  "/pipelines(.*)",
  "/api/upload(.*)",
  "/api/approve-rules(.*)",
  "/api/run-status(.*)",
  "/api/templates(.*)",
  "/api/alerts(.*)",
  "/api/chat-builder(.*)",
  "/api/download(.*)",
  "/api/pipelines(.*)",
  "/api/usage(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
