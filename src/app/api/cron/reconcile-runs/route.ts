import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const maxDuration = 30;

const STUCK_STATUSES = ["profiling", "awaiting_ai", "queued", "running"];
const STUCK_AFTER_MINUTES = 20;

export async function GET(req: Request) {
  if (req.headers.get("Authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cutoff = new Date(Date.now() - STUCK_AFTER_MINUTES * 60 * 1000).toISOString();

  const updated = await query<{ id: string }>(
    `UPDATE pipeline_runs
     SET status = 'failed',
         error_message = 'Run timed out after 20 minutes — likely a Lambda or network failure. Please retry.'
     WHERE status = ANY($1::text[])
       AND created_at < $2
     RETURNING id`,
    [STUCK_STATUSES, cutoff]
  );

  console.log(`[reconciler] Marked ${updated.length} stuck runs as failed`);
  return NextResponse.json({ fixed: updated.length, run_ids: updated.map((r) => r.id) });
}
