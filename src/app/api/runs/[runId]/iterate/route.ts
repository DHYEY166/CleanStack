import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { S3Client, CopyObjectCommand } from "@aws-sdk/client-s3";
import { queryOne } from "@/lib/db";
import type { PipelineRun } from "@/lib/types";

const s3 = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { runId } = await params;

  // Fetch run — must belong to user's team
  const run = await queryOne<PipelineRun & { mode: string }>(
    `SELECT pr.*, p.mode
     FROM pipeline_runs pr
     JOIN pipelines p ON pr.pipeline_id = p.id
     WHERE pr.id = $1 AND p.team_id = $2`,
    [runId, userId]
  );

  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  if (run.status !== "completed") return NextResponse.json({ error: "Run not completed" }, { status: 400 });
  if (!run.processed_s3_key) return NextResponse.json({ error: "No processed output" }, { status: 400 });

  const currentIteration = run.iteration ?? 1;
  if (currentIteration >= 3) {
    return NextResponse.json({ error: "Maximum 3 passes reached" }, { status: 400 });
  }

  const ext = run.file_format ?? "csv";

  let newRun: PipelineRun | null = null;
  try {
    // Create new run record first to get its ID
    newRun = await queryOne<PipelineRun>(
      `INSERT INTO pipeline_runs
         (pipeline_id, status, file_format, raw_s3_key, started_at, iteration, parent_run_id)
       VALUES ($1, 'pending', $2, $3, now(), $4, $5)
       RETURNING *`,
      [
        run.pipeline_id,
        ext,
        `${userId}/${run.pipeline_id}/PLACEHOLDER`,
        currentIteration + 1,
        runId,
      ]
    );

    if (!newRun) return NextResponse.json({ error: "Failed to create run" }, { status: 500 });

    const newRawKey = `${userId}/${run.pipeline_id}/${newRun.id}/raw.${ext}`;

    // Copy processed output → new raw key (triggers S3 event → profiler Lambda)
    await s3.send(
      new CopyObjectCommand({
        Bucket: process.env.S3_RAW_BUCKET!,
        CopySource: `${process.env.S3_PROCESSED_BUCKET}/${run.processed_s3_key}`,
        Key: newRawKey,
      })
    );

    // Update run with correct raw_s3_key
    await queryOne(
      "UPDATE pipeline_runs SET raw_s3_key = $1 WHERE id = $2",
      [newRawKey, newRun.id]
    );

    return NextResponse.json({
      run_id: newRun.id,
      pipeline_id: run.pipeline_id,
      iteration: currentIteration + 1,
    });
  } catch (err) {
    console.error("[iterate]", err);
    // Clean up orphaned run record if S3 copy failed
    if (newRun) {
      await queryOne("DELETE FROM pipeline_runs WHERE id = $1", [newRun.id]).catch(() => {});
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
