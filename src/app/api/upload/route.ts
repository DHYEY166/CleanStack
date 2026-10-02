import { auth, currentUserEmail } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { queryOne, queryOneWithTeam } from "@/lib/db";
import { getCachedQuota } from "@/lib/quota-cache";
import { uploadLimiter, checkRateLimit } from "@/lib/rate-limit";
import type { PipelineRun } from "@/lib/types";
import { requireEnv, awsRegion } from "@/lib/env";
import { logger } from "@/lib/logger";

const log = logger.child({ route: "POST /api/upload" });

// Presigning only. Since SDK 3.729 the default (WHEN_SUPPORTED) bakes a CRC32 of the
// *empty* body (x-amz-checksum-crc32=AAAAAA==) into presigned PutObject URLs, so the
// browser's real upload does not match it (LocalStack rejects it with 400; see
// aws/aws-sdk-js-v3#6810). WHEN_REQUIRED restores the pre-3.729 URL shape.
const s3 = new S3Client({ region: awsRegion(), requestChecksumCalculation: "WHEN_REQUIRED" });

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
 * Creates a pending run and returns a presigned S3 PUT URL for the raw file.
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
          error: `Monthly row limit reached (${quota.used.toLocaleString()} / ${quota.includedRows.toLocaleString()} rows on ${quota.plan} plan). Upgrade at /pricing to continue.`,
        },
        { status: 402 }
      );
    }

    stage = "parse_body";
    const body = await req.json().catch(() => null);
    const { pipeline_id, filename } = (body ?? {}) as { pipeline_id?: string; filename?: string };

    if (!pipeline_id || !filename) {
      return NextResponse.json({ error: "pipeline_id and filename required" }, { status: 400 });
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

    const run = await queryOne<PipelineRun>(
      `INSERT INTO pipeline_runs (id, pipeline_id, status, file_format, raw_s3_key, started_at)
       VALUES ($1, $2, 'pending', $3, $4, now())
       RETURNING *`,
      [runId, pipeline_id, ext, s3Key]
    );

    if (!run) return NextResponse.json({ error: "Failed to create run" }, { status: 500 });

    stage = "presign";
    const command = new PutObjectCommand({
      Bucket: requireEnv("S3_RAW_BUCKET"),
      Key: s3Key,
      ContentType: content_type,
    });

    const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 300 });

    return NextResponse.json({ presigned_url: presignedUrl, run_id: run.id, s3_key: s3Key });
  } catch (err) {
    log.error("upload failed", { stage, err });
    return NextResponse.json(
      { error: `Upload could not be started: ${STAGE_MESSAGES[stage]} Please retry.`, stage },
      { status: stage === "quota" || stage === "auth" ? 503 : 500 }
    );
  }
}
