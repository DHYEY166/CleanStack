import { NextResponse } from "next/server";
import { S3Client } from "@aws-sdk/client-s3";
import { safeCompare } from "@/lib/secrets";
import { query } from "@/lib/db";
import { awsRegion, optionalEnv } from "@/lib/env";
import { eraseTeam } from "@/lib/erase-team";
import { logger } from "@/lib/logger";

const log = logger.child({ route: "GET /api/cron/purge-guests" });

const s3 = new S3Client({ region: awsRegion() });

export const maxDuration = 60;

/** Guests erased per call; a backlog drains over the next calls. */
export const PURGE_BATCH = 20;

/**
 * Guests to erase: expired sessions, plus guest_ teams whose pipelines are over
 * 24 h old with no live session (a session row lost or purged earlier). Teams
 * with a run still being worked on in the last 30 minutes wait for the next call.
 */
export const PURGE_CANDIDATES_SQL = `
WITH candidates AS (
  SELECT id AS team_id FROM guest_sessions WHERE expires_at < now()
  UNION
  SELECT DISTINCT p.team_id FROM pipelines p
  WHERE p.team_id LIKE 'guest\\_%'
    AND p.created_at < now() - interval '24 hours'
    AND NOT EXISTS (SELECT 1 FROM guest_sessions g WHERE g.id = p.team_id AND g.expires_at >= now())
)
SELECT c.team_id FROM candidates c
WHERE NOT EXISTS (
  SELECT 1 FROM pipeline_runs pr JOIN pipelines p ON p.id = pr.pipeline_id
  WHERE p.team_id = c.team_id
    AND pr.status IN ('profiling', 'awaiting_ai', 'queued', 'running')
    AND pr.updated_at > now() - interval '30 minutes'
)
ORDER BY c.team_id
LIMIT $1`;

/**
 * Erases expired guests: S3 objects (every version) and DB rows, through the
 * same helper as account deletion. bedrock_usage rows are kept for the AI
 * spend accounting. Call it hourly with Authorization: Bearer $CRON_SECRET
 * (README, Deployment). The S3 lifecycle rule on the guest_ prefix is the
 * backstop if this stops running.
 */
export async function GET(req: Request) {
  const expected = optionalEnv("CRON_SECRET") ?? "";
  if (!expected || !safeCompare(req.headers.get("Authorization") ?? "", `Bearer ${expected}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const candidates = await query<{ team_id: string }>(PURGE_CANDIDATES_SQL, [PURGE_BATCH]);
  const purged: string[] = [];
  const failed: Array<{ team_id: string; stage: string }> = [];
  for (const { team_id } of candidates) {
    if (!team_id.startsWith("guest_")) continue; // never erase a real user here
    const result = await eraseTeam(s3, team_id, { keepUsage: true });
    if (result.ok) purged.push(team_id);
    else failed.push({ team_id, stage: result.stage });
  }
  log.info("purged guests", { purged: purged.length, failed: failed.length, batch_full: candidates.length === PURGE_BATCH });
  return NextResponse.json({ purged: purged.length, failed, more: candidates.length === PURGE_BATCH });
}
