import { SignIn } from "@clerk/nextjs";
import { TestSignInForm } from "@/components/TestAuth";
import { isTestMode } from "@/lib/test-mode";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string | string[] }>;
}) {
  // TEST MODE ONLY: Clerk needs real keys, so e2e signs in through /api/test-auth.
  if (isTestMode()) {
    const { redirect_url } = await searchParams;
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <TestSignInForm redirectUrl={typeof redirect_url === "string" ? redirect_url : undefined} />
      </div>
    );
  }
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950">
      <SignIn />
    </div>
  );
}
