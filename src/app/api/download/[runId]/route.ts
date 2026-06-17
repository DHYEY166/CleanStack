import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { queryOne } from "@/lib/db";

const s3 = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { runId } = await params;

  try {
    const run = await queryOne<{ processed_s3_key: string | null; file_format: string | null }>(
      `SELECT pr.processed_s3_key, pr.file_format
       FROM pipeline_runs pr
       JOIN pipelines p ON pr.pipeline_id = p.id
       WHERE pr.id = $1 AND p.team_id = $2 AND pr.status = 'completed'`,
      [runId, userId]
    );

    if (!run?.processed_s3_key) {
      return NextResponse.json({ error: "No processed file found" }, { status: 404 });
    }

    const obj = await s3.send(
      new GetObjectCommand({
        Bucket: process.env.S3_PROCESSED_BUCKET!,
        Key: run.processed_s3_key,
      })
    );

    const chunks: Uint8Array[] = [];
    const stream = obj.Body as AsyncIterable<Uint8Array>;
    for await (const chunk of stream) chunks.push(chunk);
    const csvBytes = Buffer.concat(chunks);

    return new NextResponse(csvBytes, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="cleaned_${runId.slice(0, 8)}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[GET /api/download]", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
