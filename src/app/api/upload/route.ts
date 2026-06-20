import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { queryOne, queryOneWithTeam } from "@/lib/db";
import { getCachedQuota } from "@/lib/quota-cache";
import { uploadLimiter, checkRateLimit } from "@/lib/rate-limit";
import type { PipelineRun } from "@/lib/types";

const s3 = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });

const ALLOWED_EXTENSIONS = new Set([
  "csv", "tsv", "txt", "json", "jsonl",
  "xlsx", "xls", "xml", "parquet",
  "pdf", "docx",
]);

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rateLimitRes = await checkRateLimit(uploadLimiter, userId);
  if (rateLimitRes) return rateLimitRes;

  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? null;

  const quota = await getCachedQuota(userId, email);
  if (quota.blocked) {
    return NextResponse.json(
      {
        error: `Monthly row limit reached (${quota.used.toLocaleString()} / ${quota.includedRows.toLocaleString()} rows on ${quota.plan} plan). Upgrade at /pricing to continue.`,
      },
      { status: 402 }
    );
  }

  const body = await req.json();
  const { pipeline_id, filename, content_type } = body;

  if (!pipeline_id || !filename || !content_type) {
    return NextResponse.json({ error: "pipeline_id, filename, content_type required" }, { status: 400 });
  }

  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return NextResponse.json({ error: `Unsupported file type: .${ext}` }, { status: 400 });
  }

  try {
    const pipeline = await queryOneWithTeam<{ id: string }>(
      userId,
      "SELECT id FROM pipelines WHERE id = $1 AND team_id = $2",
      [pipeline_id, userId]
    );
    if (!pipeline) return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });

    const run = await queryOne<PipelineRun>(
      `INSERT INTO pipeline_runs (pipeline_id, status, file_format, raw_s3_key, started_at)
       VALUES ($1, 'pending', $2, $3, now())
       RETURNING *`,
      [pipeline_id, ext, `${userId}/${pipeline_id}/PLACEHOLDER`]
    );

    if (!run) return NextResponse.json({ error: "Failed to create run" }, { status: 500 });

    const s3Key = `${userId}/${pipeline_id}/${run.id}/raw.${ext}`;

    await queryOne(
      "UPDATE pipeline_runs SET raw_s3_key = $1 WHERE id = $2",
      [s3Key, run.id]
    );

    const command = new PutObjectCommand({
      Bucket: process.env.S3_RAW_BUCKET,
      Key: s3Key,
      ContentType: content_type,
    });

    const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 300 });

    return NextResponse.json({ presigned_url: presignedUrl, run_id: run.id, s3_key: s3Key });
  } catch (err) {
    console.error("[POST /api/upload]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
