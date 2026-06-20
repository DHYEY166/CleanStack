import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { queryOne } from "@/lib/db";

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// When AI_QUEUE_ENABLED=true: enqueue to SQS → return 200 immediately (profiler doesn't wait)
// When AI_QUEUE_ENABLED=false: direct HTTP call to suggest-transforms (original behavior)
const AI_QUEUE_ENABLED = process.env.AI_QUEUE_ENABLED === "true";

const sqs = new SQSClient({ region: process.env.AWS_REGION || "us-east-1" });

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-webhook-secret");
  if (!safeCompare(secret ?? "", process.env.WEBHOOK_SECRET ?? "")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { run_id } = body;

  if (!run_id) return NextResponse.json({ error: "run_id required" }, { status: 400 });

  const TERMINAL_STATUSES = new Set(["completed", "failed", "awaiting_approval", "queued", "running"]);

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
    "UPDATE pipeline_runs SET status = 'awaiting_ai' WHERE id = $1",
    [run_id]
  );

  if (AI_QUEUE_ENABLED) {
    // Async path: enqueue and return immediately — profiler no longer blocks
    await sqs.send(new SendMessageCommand({
      QueueUrl: process.env.AI_JOBS_QUEUE_URL,
      MessageBody: JSON.stringify({ run_id }),
      MessageGroupId: undefined,
    }));
    console.log(`[profile-complete] enqueued run ${run_id} to SQS`);
    return NextResponse.json({ ok: true, queued: true });
  }

  // Sync fallback (original behavior)
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://clean-stack-eta.vercel.app";
  const res = await fetch(`${baseUrl}/api/suggest-transforms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-webhook-secret": process.env.WEBHOOK_SECRET ?? "",
    },
    body: JSON.stringify({ run_id }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error(`[profile-complete] suggest-transforms ${res.status}: ${errBody}`);
  }

  return NextResponse.json({ ok: true });
}
