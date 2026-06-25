import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { S3Client, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { query, queryOne, withTransaction } from "@/lib/db";

const s3 = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });

export const maxDuration = 60;

// GDPR Article 17 — Right to erasure
// DELETE /api/account?confirm=true
// Deletes all user data: pipelines (CASCADE → runs/profiles/rules/reviews/snapshots), S3 files, subscriptions, bedrock_usage
export async function DELETE(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Require explicit confirmation to prevent accidental or CSRF-triggered deletion
  const confirm = req.nextUrl.searchParams.get("confirm");
  if (confirm !== "true") {
    return NextResponse.json(
      { error: "Add ?confirm=true to confirm permanent account deletion. This is irreversible." },
      { status: 400 }
    );
  }

  try {
    // Collect all S3 keys before deleting DB rows
    const runs = await query<{ raw_s3_key: string | null; processed_s3_key: string | null }>(
      `SELECT pr.raw_s3_key, pr.processed_s3_key
       FROM pipeline_runs pr
       JOIN pipelines p ON pr.pipeline_id = p.id
       WHERE p.team_id = $1`,
      [userId]
    );

    const rawBucket = process.env.S3_RAW_BUCKET!;
    const procBucket = process.env.S3_PROCESSED_BUCKET!;

    // Separate raw vs processed keys by bucket — derive from key path, not content
    const rawKeys = runs
      .map((r) => r.raw_s3_key)
      .filter((k): k is string => !!k);
    const procKeys = runs
      .map((r) => r.processed_s3_key)
      .filter((k): k is string => !!k);

    // Delete in batches of 1000 (S3 limit)
    for (let i = 0; i < rawKeys.length; i += 1000) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: rawBucket,
        Delete: { Objects: rawKeys.slice(i, i + 1000).map((Key) => ({ Key })) },
      })).catch((e) => console.error("[DELETE /api/account] S3 raw delete failed:", e));
    }
    for (let i = 0; i < procKeys.length; i += 1000) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: procBucket,
        Delete: { Objects: procKeys.slice(i, i + 1000).map((Key) => ({ Key })) },
      })).catch((e) => console.error("[DELETE /api/account] S3 processed delete failed:", e));
    }

    // Delete all DB rows atomically — pipelines CASCADE removes runs/profiles/rules/reviews/snapshots
    const deleted = await withTransaction(async (txId) => {
      const result = await queryOne<{ count: string }>(
        `WITH deleted AS (
           DELETE FROM pipelines WHERE team_id = $1 RETURNING id
         ) SELECT COUNT(*)::text AS count FROM deleted`,
        [userId],
        txId
      );
      await query("DELETE FROM subscriptions WHERE team_id = $1", [userId], txId);
      await query("DELETE FROM bedrock_usage WHERE team_id = $1", [userId], txId);
      await query("DELETE FROM ai_spend_limits WHERE team_id = $1", [userId], txId);
      return result;
    });

    return NextResponse.json({
      ok: true,
      deleted_pipelines: Number((deleted as { count: string } | null)?.count ?? 0),
      deleted_raw_s3: rawKeys.length,
      deleted_processed_s3: procKeys.length,
      message: "All account data permanently deleted.",
    });
  } catch (err) {
    console.error("[DELETE /api/account]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
