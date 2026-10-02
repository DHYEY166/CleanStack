import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { queryOneWithTeam } from "@/lib/db";
import {
  DOWNLOAD_URL_TTL_SECONDS,
  attachmentDisposition,
  describeDeliverable,
} from "@/lib/download";

const s3 = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });

/**
 * Returns a short-lived presigned S3 URL for a completed run's deliverable.
 *
 * The executor writes a clean `output.<ext>` (audit `__orig_*` columns go to a
 * separate `audit.csv`), so the bytes are served exactly as stored: no
 * re-parsing or column stripping here, and no proxying of large files through
 * the serverless function.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { runId } = await params;

  try {
    const run = await queryOneWithTeam<{ processed_s3_key: string | null; file_format: string | null }>(
      userId,
      `SELECT pr.processed_s3_key, pr.file_format
       FROM pipeline_runs pr
       JOIN pipelines p ON pr.pipeline_id = p.id
       WHERE pr.id = $1 AND p.team_id = $2 AND pr.status = 'completed'`,
      [runId, userId]
    );

    if (!run?.processed_s3_key) {
      return NextResponse.json({ error: "No processed file found" }, { status: 404 });
    }

    const bucket = process.env.S3_PROCESSED_BUCKET;
    if (!bucket) {
      console.error("[GET /api/download] S3_PROCESSED_BUCKET is not set");
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }

    const d = describeDeliverable(runId, run.processed_s3_key, run.file_format);
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: bucket,
        Key: run.processed_s3_key,
        ResponseContentDisposition: attachmentDisposition(d.filename),
        ResponseContentType: d.contentType,
      }),
      { expiresIn: DOWNLOAD_URL_TTL_SECONDS }
    );

    return NextResponse.json(
      { url, filename: d.filename, format: d.format, expiresIn: DOWNLOAD_URL_TTL_SECONDS },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[GET /api/download]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
