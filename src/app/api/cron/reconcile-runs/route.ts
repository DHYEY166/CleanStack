import { NextResponse } from "next/server";
import { safeCompare } from "@/lib/secrets";
import { query } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

const log = logger.child({ route: "GET /api/cron/reconcile-runs" });

// Room for the first query to wait while Aurora resumes from auto-pause (up to
// 35s, src/lib/db-resume.ts): this rule runs every 4 hours, so the DB is usually paused.
export const maxDuration = 60;

const STUCK_AFTER_MINUTES = 20;
const PENDING_ORPHAN_AFTER_MINUTES = 60;

export async function GET(req: Request) {
  const expectedCronSecret = optionalEnv("CRON_SECRET") ?? "";
  if (!expectedCronSecret || !safeCompare(req.headers.get("Authorization") ?? "", `Bearer ${expectedCronSecret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cutoff = new Date(Date.now() - STUCK_AFTER_MINUTES * 60 * 1000).toISOString();
  const pendingCutoff = new Date(Date.now() - PENDING_ORPHAN_AFTER_MINUTES * 60 * 1000).toISOString();

  // Fail stuck in-progress runs (profiler/AI/executor claimed but never finished)
  const updated = await query<{ id: string }>(
    `UPDATE pipeline_runs
     SET status = 'failed',
         error_message = 'Run timed out after 20 minutes — likely a Lambda or network failure. Please retry.',
         updated_at = now()
     WHERE status IN ('profiling', 'awaiting_ai', 'queued', 'running')
       AND updated_at < $1
     RETURNING id`,
    [cutoff]
  );

  // Fail orphan pending runs — client got a presigned URL but never uploaded (or upload failed silently)
  const pendingCleaned = await query<{ id: string }>(
    `UPDATE pipeline_runs
     SET status = 'failed',
         error_message = 'Upload not received within 1 hour — presigned URL expired. Please retry.',
         updated_at = now()
     WHERE status = 'pending'
       AND created_at < $1
     RETURNING id`,
    [pendingCutoff]
  );

  const totalFixed = updated.length + pendingCleaned.length;
  log.info("reconciled runs", { stuck_failed: updated.length, pending_failed: pendingCleaned.length });
  return NextResponse.json({ fixed: totalFixed, stuck: updated.map((r) => r.id), orphaned: pendingCleaned.map((r) => r.id) });
}
