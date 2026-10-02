/**
 * Guest upload and pipeline caps, counted in Postgres (server only). See
 * GUEST_LIMITS in src/lib/guest-limits.ts.
 */
import { queryOne } from "@/lib/db";
import { GUEST_LIMITS } from "@/lib/guest-limits";
import type { PipelineRun } from "@/lib/types";

/**
 * Creates a guest's pending first-pass run only while (a) the guest session
 * exists and has not expired, (b) the guest has fewer than uploadsPerGuest
 * first-pass runs in 24 h and (c) all guests created from the same IP hash
 * have fewer than uploadsPerIpPerDay. One statement, so a purged or expired
 * session cannot upload. Two concurrent requests can both pass (READ
 * COMMITTED); the per-user Upstash upload limit and the row cap bound that.
 */
export const GUEST_RUN_INSERT_SQL = `
INSERT INTO pipeline_runs (id, pipeline_id, status, file_format, raw_s3_key, started_at)
SELECT $1, $2, 'pending', $3, $4, now()
FROM guest_sessions g
WHERE g.id = $5
  AND g.expires_at > now()
  AND (SELECT count(*) FROM pipeline_runs pr JOIN pipelines p ON p.id = pr.pipeline_id
       WHERE p.team_id = $5 AND pr.iteration = 1
         AND pr.created_at > now() - interval '24 hours') < $6
  AND (SELECT count(*) FROM pipeline_runs pr JOIN pipelines p ON p.id = pr.pipeline_id
       JOIN guest_sessions gs ON gs.id = p.team_id
       WHERE gs.ip_hash = g.ip_hash AND pr.iteration = 1
         AND pr.created_at > now() - interval '24 hours') < $7
RETURNING *`;

export async function insertGuestRun(opts: {
  runId: string; pipelineId: string; fileFormat: string; s3Key: string; guestId: string;
}): Promise<PipelineRun | null> {
  return queryOne<PipelineRun>(GUEST_RUN_INSERT_SQL, [
    opts.runId, opts.pipelineId, opts.fileFormat, opts.s3Key, opts.guestId,
    GUEST_LIMITS.uploadsPerGuest, GUEST_LIMITS.uploadsPerIpPerDay,
  ]);
}

/** Why insertGuestRun refused (for the error message). */
export async function guestUploadRefusal(guestId: string): Promise<string> {
  const row = await queryOne<{ live: boolean | null; mine: string; ip: string }>(
    `SELECT
       (SELECT expires_at > now() FROM guest_sessions WHERE id = $1) AS live,
       (SELECT count(*) FROM pipeline_runs pr JOIN pipelines p ON p.id = pr.pipeline_id
         WHERE p.team_id = $1 AND pr.iteration = 1 AND pr.created_at > now() - interval '24 hours') AS mine,
       (SELECT count(*) FROM pipeline_runs pr JOIN pipelines p ON p.id = pr.pipeline_id
         JOIN guest_sessions gs ON gs.id = p.team_id
         WHERE gs.ip_hash = (SELECT ip_hash FROM guest_sessions WHERE id = $1)
           AND pr.iteration = 1 AND pr.created_at > now() - interval '24 hours') AS ip`,
    [guestId]
  );
  if (!row?.live) return "Your guest session has expired. Start a new one or sign up.";
  if (Number(row.mine) >= GUEST_LIMITS.uploadsPerGuest) {
    return `Guests can upload ${GUEST_LIMITS.uploadsPerGuest} files. Sign up to keep going.`;
  }
  return `Guest upload limit for your network reached (${GUEST_LIMITS.uploadsPerIpPerDay} per day). Sign up to keep going.`;
}

/** Inserts a guest pipeline only while the guest has fewer than pipelinesPerGuest. */
export const GUEST_PIPELINE_INSERT_SQL = `
INSERT INTO pipelines (name, description, owner_id, team_id)
SELECT $1, $2, $3, $3
WHERE (SELECT count(*) FROM pipelines WHERE team_id = $3) < $4
RETURNING *`;
