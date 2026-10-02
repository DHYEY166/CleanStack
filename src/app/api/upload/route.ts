import { auth, currentUserEmail } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { queryOne, queryOneWithTeam } from "@/lib/db";
import { getCachedQuota } from "@/lib/quota-cache";
import { quotaBlockedMessage } from "@/lib/billing";
import { uploadLimiter, checkRateLimit } from "@/lib/rate-limit";
import type { PipelineRun } from "@/lib/types";
import { requireEnv, awsRegion } from "@/lib/env";
import { logger } from "@/lib/logger";
import { formatMb, maxUploadBytesFor } from "@/lib/upload-limits";
import { isGuestId } from "@/lib/guest";
import { guestUploadRefusal, insertGuestRun } from "@/lib/guest-quota";

const log = logger.child({ route: "POST /api/upload" });

// Presigning only. The upload is a presigned POST (not PUT) so the policy can carry
// content-length-range: S3 itself rejects a body over the limit. WHEN_REQUIRED keeps
// the SDK from adding checksum fields the browser's body would not match
// (aws/aws-sdk-js-v3#6810).
const s3 = new S3Client({ region: awsRegion(), requestChecksumCalculation: "WHEN_REQUIRED" });

/** Presigned POST lifetime. */
const UPLOAD_EXPIRES_SECONDS = 300;

const ALLOWED_EXTENSIONS = new Set([
  "csv", "tsv", "txt", "json", "jsonl",
  "xlsx", "xls", "xml",
  "pdf", "docx",
]);

const EXT_CONTENT_TYPES: Record<string, string> = {
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  json: "application/json",
  jsonl: "application/jsonlines",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  xml: "application/xml",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

type Stage = "auth" | "rate_limit" | "user_email" | "quota" | "parse_body" | "lookup_pipeline" | "create_run" | "presign";

const STAGE_MESSAGES: Record<Stage, string> = {
  auth: "Could not verify your session.",
  rate_limit: "Could not check the upload rate limit.",
  user_email: "Could not load your account.",
  quota: "Could not check your monthly usage quota.",
  parse_body: "Could not read the request.",
  lookup_pipeline: "Could not load the pipeline.",
  create_run: "Could not create the pipeline run.",
  presign: "Could not prepare the file upload.",
};

/**
 * Creates a pending run and returns a presigned S3 POST (url + form fields) for
 * the raw file. Body: { pipeline_id, filename, size } (size in bytes). A file
 * over the caller's limit (src/lib/upload-limits.ts: 100 MB, guests 2 MB) is
 * refused here with 413; the POST policy's content-length-range makes S3
 * enforce the same limit on the actual bytes, and the profiler checks again.
 *
 * Every step runs inside one try/catch. Previously auth, rate limiting, the
 * Clerk email lookup and the quota query ran outside it, so any throw there
 * escaped the handler and Next.js answered 500 with an EMPTY body, which the
 * browser reported as "Unexpected end of JSON input". In production that
 * throw was the Upstash rate limiter failing DNS ("TypeError: fetch failed
 * ... getaddrinfo"); see checkRateLimit. Failures now return JSON naming the step
 * that failed and are logged with the same `stage`, so Vercel runtime logs
 * show the underlying error.
 */
/** The caller's per-file limit, so the upload form can refuse a large file before creating anything. */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ max_bytes: maxUploadBytesFor(userId) });
}

export async function POST(req: NextRequest) {
  let stage: Stage = "auth";
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // checkRateLimit never throws: an unreachable Upstash fails open (logged).
    stage = "rate_limit";
    const rateLimitRes = await checkRateLimit(uploadLimiter, userId);
    if (rateLimitRes) return rateLimitRes;

    // The email only feeds the admin bypass; without it the user is treated as a normal user.
    stage = "user_email";
    let email: string | null = null;
    try {
      email = await currentUserEmail();
    } catch (err) {
      log.warn("could not load the user's email; admin bypass not applied", { stage, err });
    }

    stage = "quota";
    const quota = await getCachedQuota(userId, email, userId);
    if (quota.blocked) {
      return NextResponse.json(
        {
          error: quotaBlockedMessage(quota),
        },
        { status: 402 }
      );
    }

    stage = "parse_body";
    const body = await req.json().catch(() => null);
    const { pipeline_id, filename, size } = (body ?? {}) as { pipeline_id?: string; filename?: string; size?: unknown };

    if (!pipeline_id || !filename) {
      return NextResponse.json({ error: "pipeline_id and filename required" }, { status: 400 });
    }
    const maxBytes = maxUploadBytesFor(userId);
    if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
      return NextResponse.json({ error: "size (file size in bytes) required" }, { status: 400 });
    }
    if (size > maxBytes) {
      return NextResponse.json(
        { error: `File is ${formatMb(size)}; the limit is ${formatMb(maxBytes)} per file.`, max_bytes: maxBytes },
        { status: 413 }
      );
    }

    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return NextResponse.json({ error: `Unsupported file type: .${ext}` }, { status: 400 });
    }

    // Derive content_type server-side — never trust client-supplied value
    const content_type = EXT_CONTENT_TYPES[ext] ?? "application/octet-stream";

    stage = "lookup_pipeline";
    const pipeline = await queryOneWithTeam<{ id: string }>(
      userId,
      "SELECT id FROM pipelines WHERE id = $1 AND team_id = $2",
      [pipeline_id, userId]
    );
    if (!pipeline) return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });

    stage = "create_run";
    const runId = randomUUID();
    const s3Key = `${userId}/${pipeline_id}/${runId}/raw.${ext}`;

    // Guests: the insert itself enforces the per-guest and per-IP upload caps.
    const guest = isGuestId(userId);
    const run = guest
      ? await insertGuestRun({ runId, pipelineId: pipeline_id, fileFormat: ext, s3Key, guestId: userId })
      : await queryOne<PipelineRun>(
          `INSERT INTO pipeline_runs (id, pipeline_id, status, file_format, raw_s3_key, started_at)
           VALUES ($1, $2, 'pending', $3, $4, now())
           RETURNING *`,
          [runId, pipeline_id, ext, s3Key]
        );
    if (!run && guest) {
      return NextResponse.json({ error: await guestUploadRefusal(userId), guest: true }, { status: 429 });
    }

    if (!run) return NextResponse.json({ error: "Failed to create run" }, { status: 500 });

    stage = "presign";
    const upload = await createPresignedPost(s3, {
      Bucket: requireEnv("S3_RAW_BUCKET"),
      Key: s3Key,
      Conditions: [
        ["content-length-range", 1, maxBytes],
        ["eq", "$Content-Type", content_type],
      ],
      Fields: { "Content-Type": content_type },
      Expires: UPLOAD_EXPIRES_SECONDS,
    });

    return NextResponse.json({ upload, max_bytes: maxBytes, run_id: run.id, s3_key: s3Key });
  } catch (err) {
    log.error("upload failed", { stage, err });
    return NextResponse.json(
      { error: `Upload could not be started: ${STAGE_MESSAGES[stage]} Please retry.`, stage },
      { status: stage === "quota" || stage === "auth" ? 503 : 500 }
    );
  }
}
