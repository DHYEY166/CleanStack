import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { S3Client } from "@aws-sdk/client-s3";
import { query, queryOne, withTransaction } from "@/lib/db";
import { keyDirectory, purgePrefix, type PurgeResult } from "@/lib/s3-erase";
import { requireEnv, awsRegion } from "@/lib/env";

const s3 = new S3Client({ region: awsRegion() });

export const maxDuration = 60;

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

// GDPR Article 17 — Right to erasure
// DELETE /api/account?confirm=true
//
// 1. Purge S3 first: every object version + delete marker under the user's raw
//    prefix (`${userId}/` — raw uploads, extracted_text.txt, iteration copies)
//    and under `processed/${pipelineId}/` for each of the team's pipelines
//    (deliverables + audit.csv), plus the directory of any recorded key that
//    lives outside those prefixes.
// 2. Only if S3 succeeded, delete the DB rows atomically (pipelines CASCADE →
//    runs/profiles/rules/reviews/snapshots, then subscriptions, bedrock_usage,
//    ai_spend_limits). If S3 fails we return 500 with the DB intact so the
//    request can be retried — deleting the rows first would orphan the files.
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

  // The user id becomes an S3 prefix; never let an unexpected value widen it.
  if (!SAFE_ID.test(userId)) {
    console.error("[DELETE /api/account] unexpected user id format; refusing S3 purge");
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  let rawBucket: string;
  let procBucket: string;
  try {
    rawBucket = requireEnv("S3_RAW_BUCKET");
    procBucket = requireEnv("S3_PROCESSED_BUCKET");
  } catch (err) {
    console.error("[DELETE /api/account] refusing partial erasure:", (err as Error).message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  let purges: PurgeResult[];
  try {
    const pipelines = await query<{ id: string }>(`SELECT id FROM pipelines WHERE team_id = $1`, [userId]);
    const runs = await query<{ raw_s3_key: string | null; processed_s3_key: string | null }>(
      `SELECT pr.raw_s3_key, pr.processed_s3_key
       FROM pipeline_runs pr
       JOIN pipelines p ON pr.pipeline_id = p.id
       WHERE p.team_id = $1`,
      [userId]
    );

    const rawPrefixes = new Set<string>([`${userId}/`]);
    const procPrefixes = new Set<string>(
      pipelines.filter((p) => SAFE_ID.test(p.id)).map((p) => `processed/${p.id}/`)
    );
    const covered = (key: string, prefixes: Set<string>) => [...prefixes].some((p) => key.startsWith(p));
    for (const r of runs) {
      const rawDir = r.raw_s3_key ? keyDirectory(r.raw_s3_key) : null;
      if (rawDir && !covered(r.raw_s3_key!, rawPrefixes)) rawPrefixes.add(rawDir);
      const procDir = r.processed_s3_key ? keyDirectory(r.processed_s3_key) : null;
      if (procDir && !covered(r.processed_s3_key!, procPrefixes)) procPrefixes.add(procDir);
    }

    purges = [];
    for (const prefix of rawPrefixes) purges.push(await purgePrefix(s3, rawBucket, prefix));
    for (const prefix of procPrefixes) purges.push(await purgePrefix(s3, procBucket, prefix));

    const unversioned = purges.filter((p) => !p.versioned).map((p) => p.prefix);
    if (unversioned.length) {
      // Missing s3:ListBucketVersions: only current versions were removed and
      // older versions may survive on a versioned bucket. Surfaced in the
      // response and logs; fix the IAM policy (see README, security model).
      console.error("[DELETE /api/account] ListObjectVersions denied; only current versions purged for", unversioned);
    }

    const failures = purges.flatMap((p) => p.errors);
    if (failures.length) {
      console.error("[DELETE /api/account] S3 purge incomplete:", failures.slice(0, 20));
      return NextResponse.json(
        { error: "Could not delete all stored files. No account data was removed; please retry." },
        { status: 500 }
      );
    }
  } catch (err) {
    console.error("[DELETE /api/account] S3 purge failed:", err);
    return NextResponse.json(
      { error: "Could not delete all stored files. No account data was removed; please retry." },
      { status: 500 }
    );
  }

  try {
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
      deleted_s3_objects: purges.reduce((n, p) => n + p.deleted, 0),
      all_versions_purged: purges.every((p) => p.versioned),
      message: "All account data permanently deleted.",
    });
  } catch (err) {
    console.error("[DELETE /api/account] DB delete failed after S3 purge:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
