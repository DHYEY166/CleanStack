/**
 * Erase everything a team (a Clerk user or a guest) stored: S3 first, then the
 * database rows, so a failure never orphans files. Shared by
 * DELETE /api/account (GDPR Article 17) and /api/cron/purge-guests.
 *
 * 1. Purge every object version and delete marker under the raw prefix
 *    `${teamId}/` (uploads, extracted_text.txt, iteration copies) and under
 *    `processed/${pipelineId}/` for each pipeline (deliverables + audit.csv),
 *    plus the directory of any recorded key outside those prefixes.
 * 2. Only if S3 succeeded, delete the rows in one transaction: pipelines
 *    (CASCADE -> runs, profiles, rules, reviews, snapshots), subscriptions,
 *    ai_spend_limits, guest_sessions, and bedrock_usage unless keepUsage.
 *
 * Guests keep their bedrock_usage rows (keepUsage) so the all-guests daily AI
 * cap still sees spend from guests purged earlier that day.
 */
import type { S3Client } from "@aws-sdk/client-s3";
import { query, queryOne, withTransaction } from "@/lib/db";
import { keyDirectory, purgePrefix, type PurgeResult } from "@/lib/s3-erase";
import { requireEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

const log = logger.child({ component: "erase-team" });

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export type EraseResult =
  | { ok: true; deletedPipelines: number; deletedS3Objects: number; allVersionsPurged: boolean }
  | { ok: false; stage: "unsafe_id" | "config" | "s3" | "db" };

export async function eraseTeam(s3: S3Client, teamId: string, opts: { keepUsage?: boolean } = {}): Promise<EraseResult> {
  // The id becomes an S3 prefix; never let an unexpected value widen it.
  if (!SAFE_ID.test(teamId)) {
    log.error("unexpected team id format; refusing S3 purge");
    return { ok: false, stage: "unsafe_id" };
  }

  let rawBucket: string;
  let procBucket: string;
  try {
    rawBucket = requireEnv("S3_RAW_BUCKET");
    procBucket = requireEnv("S3_PROCESSED_BUCKET");
  } catch (err) {
    log.error("refusing partial erasure", { err });
    return { ok: false, stage: "config" };
  }

  let purges: PurgeResult[];
  try {
    const pipelines = await query<{ id: string }>(`SELECT id FROM pipelines WHERE team_id = $1`, [teamId]);
    const runs = await query<{ raw_s3_key: string | null; processed_s3_key: string | null }>(
      `SELECT pr.raw_s3_key, pr.processed_s3_key
       FROM pipeline_runs pr
       JOIN pipelines p ON pr.pipeline_id = p.id
       WHERE p.team_id = $1`,
      [teamId]
    );

    const rawPrefixes = new Set<string>([`${teamId}/`]);
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
      // older versions may survive on a versioned bucket (docs/security-model.md).
      log.error("ListObjectVersions denied; only current versions purged", { prefixes: unversioned });
    }

    const failures = purges.flatMap((p) => p.errors);
    if (failures.length) {
      log.error("S3 purge incomplete; database left intact", { failures: failures.slice(0, 20), failure_count: failures.length });
      return { ok: false, stage: "s3" };
    }
  } catch (err) {
    log.error("S3 purge failed; database left intact", { err });
    return { ok: false, stage: "s3" };
  }

  try {
    const deleted = await withTransaction(async (txId) => {
      const result = await queryOne<{ count: string }>(
        `WITH deleted AS (
           DELETE FROM pipelines WHERE team_id = $1 RETURNING id
         ) SELECT COUNT(*)::text AS count FROM deleted`,
        [teamId],
        txId
      );
      await query("DELETE FROM subscriptions WHERE team_id = $1", [teamId], txId);
      if (!opts.keepUsage) await query("DELETE FROM bedrock_usage WHERE team_id = $1", [teamId], txId);
      await query("DELETE FROM ai_spend_limits WHERE team_id = $1", [teamId], txId);
      await query("DELETE FROM guest_sessions WHERE id = $1", [teamId], txId);
      return result;
    });
    return {
      ok: true,
      deletedPipelines: Number((deleted as { count: string } | null)?.count ?? 0),
      deletedS3Objects: purges.reduce((n, p) => n + p.deleted, 0),
      allVersionsPurged: purges.every((p) => p.versioned),
    };
  } catch (err) {
    log.error("DB delete failed after S3 purge", { err });
    return { ok: false, stage: "db" };
  }
}
