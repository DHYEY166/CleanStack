import { SignIn } from "@clerk/nextjs";
import { TestSignInForm } from "@/components/TestAuth";
import { isTestMode } from "@/lib/test-mode";
import { GuestStartButton } from "@/components/Guest";

const GUEST_BUTTON = "inline-flex items-center gap-2 border border-gray-700 hover:border-gray-500 text-gray-300 hover:text-white px-5 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string | string[] }>;
}) {
  // TEST MODE ONLY: Clerk needs real keys, so e2e signs in through /api/test-auth.
  if (isTestMode()) {
    const { redirect_url } = await searchParams;
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-6 bg-gray-950">
        <TestSignInForm redirectUrl={typeof redirect_url === "string" ? redirect_url : undefined} />
        <GuestStartButton className={GUEST_BUTTON} />
      </div>
    );
  }
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 bg-gray-950">
      <SignIn />
      <GuestStartButton className={GUEST_BUTTON} />
    </div>
  );
}
