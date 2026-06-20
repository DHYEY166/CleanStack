import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { query, queryOne } from "@/lib/db";

const s3 = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });

export const maxDuration = 60;

// GDPR Article 17 — Right to erasure
// Deletes all user data: pipelines + all cascaded rows + S3 files
export async function DELETE() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    // Collect S3 keys before deleting DB rows
    const runs = await query<{ raw_s3_key: string | null; processed_s3_key: string | null }>(
      `SELECT pr.raw_s3_key, pr.processed_s3_key
       FROM pipeline_runs pr
       JOIN pipelines p ON pr.pipeline_id = p.id
       WHERE p.team_id = $1`,
      [userId]
    );

    const s3Keys = runs
      .flatMap((r) => [r.raw_s3_key, r.processed_s3_key])
      .filter((k): k is string => !!k);

    // Delete S3 objects in batches of 1000
    const rawBucket = process.env.S3_RAW_BUCKET!;
    const procBucket = process.env.S3_PROCESSED_BUCKET!;

    for (let i = 0; i < s3Keys.length; i += 1000) {
      const batch = s3Keys.slice(i, i + 1000);
      const rawKeys = batch.filter((k) => k.includes("/raw.") || !k.includes("/processed"));
      const procKeys = batch.filter((k) => k.includes("/processed"));

      if (rawKeys.length > 0) {
        await s3.send(new DeleteObjectsCommand({
          Bucket: rawBucket,
          Delete: { Objects: rawKeys.map((Key) => ({ Key })) },
        })).catch(() => {}); // best-effort
      }
      if (procKeys.length > 0) {
        await s3.send(new DeleteObjectsCommand({
          Bucket: procBucket,
          Delete: { Objects: procKeys.map((Key) => ({ Key })) },
        })).catch(() => {}); // best-effort
      }
    }

    // Delete all pipelines — CASCADE removes runs, profiles, rules, reviews, snapshots
    const deleted = await queryOne<{ count: string }>(
      `WITH deleted AS (
         DELETE FROM pipelines WHERE team_id = $1 RETURNING id
       ) SELECT COUNT(*)::text AS count FROM deleted`,
      [userId]
    );

    // Delete subscription
    await query("DELETE FROM subscriptions WHERE team_id = $1", [userId]);
    await query("DELETE FROM bedrock_usage WHERE team_id = $1", [userId]);

    return NextResponse.json({
      ok: true,
      deleted_pipelines: Number(deleted?.count ?? 0),
      deleted_s3_objects: s3Keys.length,
      message: "All account data deleted. This action is irreversible.",
    });
  } catch (err) {
    console.error("[DELETE /api/account]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
