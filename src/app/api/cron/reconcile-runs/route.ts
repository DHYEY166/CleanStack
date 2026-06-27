import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { query } from "@/lib/db";

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export const maxDuration = 30;

const STUCK_AFTER_MINUTES = 20;
const PENDING_ORPHAN_AFTER_MINUTES = 60;

export async function GET(req: Request) {
  const expectedCronSecret = process.env.CRON_SECRET ?? "";
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
  console.log(`[reconciler] Marked ${updated.length} stuck runs + ${pendingCleaned.length} orphan pending runs as failed`);
  return NextResponse.json({ fixed: totalFixed, stuck: updated.map((r) => r.id), orphaned: pendingCleaned.map((r) => r.id) });
}
