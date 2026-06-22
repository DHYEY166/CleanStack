import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { S3Client, CopyObjectCommand } from "@aws-sdk/client-s3";
import { queryOne, queryOneWithTeam } from "@/lib/db";
import type { PipelineRun } from "@/lib/types";

const s3 = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { runId } = await params;

  const run = await queryOneWithTeam<PipelineRun>(
    userId,
    `SELECT pr.*
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

  try {
    const newRun = await queryOne<PipelineRun>(
      `INSERT INTO pipeline_runs
         (pipeline_id, status, file_format, raw_s3_key, started_at, iteration, parent_run_id, auto_mode)
       VALUES ($1, 'pending', $2, $3, now(), $4, $5, TRUE)
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

    await s3.send(
      new CopyObjectCommand({
        Bucket: process.env.S3_RAW_BUCKET!,
        CopySource: `${process.env.S3_PROCESSED_BUCKET}/${run.processed_s3_key}`,
        Key: newRawKey,
      })
    );

    await queryOne(
      "UPDATE pipeline_runs SET raw_s3_key = $1 WHERE id = $2",
      [newRawKey, newRun.id]
    );

    return NextResponse.json({
      run_id: newRun.id,
      pipeline_id: run.pipeline_id,
      iteration: currentIteration + 1,
      auto_mode: true,
    });
  } catch (err) {
    console.error("[auto-clean]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
