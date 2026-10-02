"use client";

/**
 * TEST MODE ONLY client helpers. The root layout renders <TestAuthProvider>
 * instead of <ClerkProvider> only when isTestMode() is true on the server;
 * in every other build the context stays undefined and these render nothing.
 */
import { createContext, useContext } from "react";

const TestAuthContext = createContext<{ enabled: true } | undefined>(undefined);

export function TestAuthProvider({ children }: { children: React.ReactNode }) {
  return <TestAuthContext.Provider value={{ enabled: true }}>{children}</TestAuthContext.Provider>;
}

export function useTestAuthEnabled(): boolean {
  return useContext(TestAuthContext)?.enabled === true;
}

export function TestSignOutButton() {
  return (
    <button
      type="button"
      data-testid="test-sign-out"
      className="text-xs text-gray-400 hover:text-white"
      onClick={async () => {
        await fetch("/api/test-auth", { method: "DELETE" });
        window.location.assign("/");
      }}
    >
      Sign out (test mode)
    </button>
  );
}

export function TestSignInForm({ redirectUrl }: { redirectUrl?: string }) {
  return (
    <form method="post" action="/api/test-auth" className="bg-gray-900 border border-yellow-600 rounded-lg p-6 w-80 space-y-4">
      <p className="text-yellow-400 text-sm font-semibold">Test mode sign-in (no Clerk)</p>
      <label className="block text-sm text-gray-300">
        Test user id
        <input
          name="user_id"
          defaultValue="user_test_e2e"
          className="mt-1 w-full rounded bg-gray-800 px-2 py-1 text-white"
        />
      </label>
      <input type="hidden" name="redirect_url" value={redirectUrl ?? "/dashboard"} />
      <button type="submit" className="w-full rounded bg-blue-600 py-1.5 text-white">
        Sign in
      </button>
    </form>
  );
}
