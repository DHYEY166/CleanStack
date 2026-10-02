import { NextRequest, NextResponse } from "next/server";
import { safeCompare } from "@/lib/secrets";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { queryOne } from "@/lib/db";
import { requireEnv, optionalEnv, awsRegion } from "@/lib/env";

// When AI_QUEUE_ENABLED=true: enqueue to SQS → return 200 immediately (profiler doesn't wait)
// When AI_QUEUE_ENABLED=false: direct HTTP call to suggest-transforms (original behavior)
const AI_QUEUE_ENABLED = optionalEnv("AI_QUEUE_ENABLED") === "true";

const sqs = new SQSClient({ region: awsRegion() });

export const maxDuration = 300;

const TERMINAL_STATUSES = new Set(["completed", "failed", "awaiting_approval", "queued", "running"]);

export async function POST(req: NextRequest) {
  const expectedSecret = optionalEnv("WEBHOOK_SECRET") ?? "";
  if (!expectedSecret) {
    console.error("[profile-complete] WEBHOOK_SECRET not set — rejecting request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const secret = req.headers.get("x-webhook-secret");
  if (!safeCompare(secret ?? "", expectedSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { run_id } = body;

  if (!run_id) return NextResponse.json({ error: "run_id required" }, { status: 400 });

  const run = await queryOne<{ id: string; pipeline_id: string; raw_s3_key: string; status: string }>(
    "SELECT id, pipeline_id, raw_s3_key, status FROM pipeline_runs WHERE id = $1",
    [run_id]
  );

  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  // Prevent resetting terminal-state runs — blocks attacker resetting completed/approved runs
  if (TERMINAL_STATUSES.has(run.status)) {
    console.log(`[profile-complete] run ${run_id} already in terminal state ${run.status}, skipping`);
    return NextResponse.json({ ok: true, skipped: true });
  }

  // Validate S3 key has expected structure (4 path segments)
  const keyParts = (run.raw_s3_key ?? "").split("/");
  if (keyParts.length < 4) {
    console.error(`[profile-complete] invalid S3 key structure for run ${run_id}`);
    return NextResponse.json({ error: "Invalid run state" }, { status: 400 });
  }

  await queryOne(
    "UPDATE pipeline_runs SET status = 'awaiting_ai', updated_at = now() WHERE id = $1",
    [run_id]
  );

  if (AI_QUEUE_ENABLED) {
    // Async path: enqueue and return immediately — profiler no longer blocks
    await sqs.send(new SendMessageCommand({
      QueueUrl: requireEnv("AI_JOBS_QUEUE_URL"),
      MessageBody: JSON.stringify({ run_id }),
      MessageGroupId: undefined,
    }));
    console.log(`[profile-complete] enqueued run ${run_id} to SQS`);
    return NextResponse.json({ ok: true, queued: true });
  }

  // Sync fallback (original behavior)
  const baseUrl = optionalEnv("NEXT_PUBLIC_APP_URL") ?? "https://clean-stack-eta.vercel.app";
  const res = await fetch(`${baseUrl}/api/suggest-transforms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-webhook-secret": optionalEnv("WEBHOOK_SECRET") ?? "",
    },
    body: JSON.stringify({ run_id }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error(`[profile-complete] suggest-transforms ${res.status}: ${errBody}`);
  }

  return NextResponse.json({ ok: true });
}
