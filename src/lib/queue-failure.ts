/**
 * What a route does when SendMessage to the executor queue or the AI jobs
 * queue fails after it has moved a run forward (to 'queued' or 'awaiting_ai').
 *
 * Without a message nothing would ever pick the run up: the reconcile-runs
 * cron only marks it failed 20 minutes later. So the route fails the run now,
 * with a message the run page shows, and answers 503.
 *
 * The UPDATE is conditional on the status the route set. SendMessage can fail
 * after SQS accepted the message (a timeout), and if a worker has already
 * claimed the run (for example 'queued' -> 'running') it is left alone.
 */
import { NextResponse } from "next/server";
import { queryOne } from "@/lib/db";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "queue-failure" });

export const EXECUTOR_QUEUE_FAILED_MESSAGE =
  "Could not queue this run for execution (the job queue was unavailable). The run was marked failed; upload the file again to retry.";

export const AI_QUEUE_FAILED_MESSAGE =
  "Could not queue this run for AI suggestions (the job queue was unavailable). The run was marked failed; upload the file again to retry.";

/** Marks the run failed if it is still in `fromStatus`. Returns whether it did. Never throws. */
export async function failRunAfterQueueError(
  runId: string,
  fromStatus: "queued" | "awaiting_ai",
  message: string
): Promise<boolean> {
  try {
    const row = await queryOne<{ id: string }>(
      `UPDATE pipeline_runs SET status = 'failed', error_message = $3, updated_at = now()
       WHERE id = $1 AND status = $2
       RETURNING id`,
      [runId, fromStatus, message]
    );
    return !!row;
  } catch (err) {
    // The reconcile-runs cron still fails the run after 20 minutes.
    log.error("could not mark run failed after SQS send error", { run_id: runId, err });
    return false;
  }
}

export function queueErrorResponse(message: string): NextResponse {
  return NextResponse.json({ error: message, run_status: "failed" }, { status: 503 });
}
