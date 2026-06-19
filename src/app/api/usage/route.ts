import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { checkQuota } from "@/lib/billing";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? null;

  const quota = await checkQuota(userId, email);

  const percentage =
    quota.isAdmin || quota.includedRows === Infinity
      ? 0
      : Math.min(100, Math.round((quota.used / quota.includedRows) * 100));

  return NextResponse.json({ ...quota, percentage });
}
