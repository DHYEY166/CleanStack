import { auth } from "@/lib/auth";
import { forbidGuest } from "@/lib/guest-guard";
import { NextRequest, NextResponse } from "next/server";
import { S3Client } from "@aws-sdk/client-s3";
import { awsRegion } from "@/lib/env";
import { eraseTeam } from "@/lib/erase-team";

const s3 = new S3Client({ region: awsRegion() });

export const maxDuration = 60;

// GDPR Article 17 — Right to erasure
// DELETE /api/account?confirm=true. S3 first, then the DB rows; see src/lib/erase-team.ts.
export async function DELETE(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const guestRes = forbidGuest(userId);
  if (guestRes) return guestRes;

  // Require explicit confirmation to prevent accidental or CSRF-triggered deletion
  const confirm = req.nextUrl.searchParams.get("confirm");
  if (confirm !== "true") {
    return NextResponse.json(
      { error: "Add ?confirm=true to confirm permanent account deletion. This is irreversible." },
      { status: 400 }
    );
  }

  const result = await eraseTeam(s3, userId);
  if (!result.ok) {
    return result.stage === "s3"
      ? NextResponse.json({ error: "Could not delete all stored files. No account data was removed; please retry." }, { status: 500 })
      : NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    deleted_pipelines: result.deletedPipelines,
    deleted_s3_objects: result.deletedS3Objects,
    all_versions_purged: result.allVersionsPurged,
    message: "All account data permanently deleted.",
  });
}
