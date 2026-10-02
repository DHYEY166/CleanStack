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

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rateLimitRes = await checkRateLimit(uploadLimiter, userId);
  if (rateLimitRes) return rateLimitRes;

  const email = await currentUserEmail();

  const quota = await getCachedQuota(userId, email, userId);
  if (quota.blocked) {
    return NextResponse.json(
      {
        error: `Monthly row limit reached (${quota.used.toLocaleString()} / ${quota.includedRows.toLocaleString()} rows on ${quota.plan} plan). Upgrade at /pricing to continue.`,
      },
      { status: 402 }
    );
  }

  const body = await req.json();
  const { pipeline_id, filename } = body;

  if (!pipeline_id || !filename) {
    return NextResponse.json({ error: "pipeline_id and filename required" }, { status: 400 });
  }

  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return NextResponse.json({ error: `Unsupported file type: .${ext}` }, { status: 400 });
  }

  // Derive content_type server-side — never trust client-supplied value
  const content_type = EXT_CONTENT_TYPES[ext] ?? "application/octet-stream";

  try {
    const pipeline = await queryOneWithTeam<{ id: string }>(
      userId,
      "SELECT id FROM pipelines WHERE id = $1 AND team_id = $2",
      [pipeline_id, userId]
    );
    if (!pipeline) return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });

    const runId = randomUUID();
    const s3Key = `${userId}/${pipeline_id}/${runId}/raw.${ext}`;

    const run = await queryOne<PipelineRun>(
      `INSERT INTO pipeline_runs (id, pipeline_id, status, file_format, raw_s3_key, started_at)
       VALUES ($1, $2, 'pending', $3, $4, now())
       RETURNING *`,
      [runId, pipeline_id, ext, s3Key]
    );

    if (!run) return NextResponse.json({ error: "Failed to create run" }, { status: 500 });

    const command = new PutObjectCommand({
      Bucket: requireEnv("S3_RAW_BUCKET"),
      Key: s3Key,
      ContentType: content_type,
    });

    const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 300 });

    return NextResponse.json({ presigned_url: presignedUrl, run_id: run.id, s3_key: s3Key });
  } catch (err) {
    log.error("unhandled error", { err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
