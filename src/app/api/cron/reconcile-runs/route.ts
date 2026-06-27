import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { query } from "@/lib/db";

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export const maxDuration = 30;

const STUCK_AFTER_MINUTES = 20;

export async function GET(req: Request) {
  const expectedCronSecret = process.env.CRON_SECRET ?? "";
  if (!expectedCronSecret || !safeCompare(req.headers.get("Authorization") ?? "", `Bearer ${expectedCronSecret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cutoff = new Date(Date.now() - STUCK_AFTER_MINUTES * 60 * 1000).toISOString();

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

  console.log(`[reconciler] Marked ${updated.length} stuck runs as failed`);
  return NextResponse.json({ fixed: updated.length, run_ids: updated.map((r) => r.id) });
}
