import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

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
  "/api/runs(.*)",
  "/api/export-training(.*)",
  "/api/account(.*)",
]);

const isRootPath = createRouteMatcher(["/"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
    return;
  }

  // Redirect authenticated users from landing page → dashboard
  if (isRootPath(req)) {
    const { userId } = await auth();
    if (userId) {
      return NextResponse.redirect(new URL("/dashboard", req.url));
    }
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
