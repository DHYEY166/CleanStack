import { auth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { queryOneWithTeam } from "@/lib/db";
import { aiLimiter, checkRateLimit } from "@/lib/rate-limit";
import { deliverableFormat } from "@/lib/download";
import { parseDeliverableRows, toTrainingFormat, type TrainingFormat } from "@/lib/training-export";
import { requireEnv, awsRegion } from "@/lib/env";
import { logger } from "@/lib/logger";

const log = logger.child({ route: "GET /api/export-training" });

const s3 = new S3Client({ region: awsRegion() });

type SplitRatio = "none" | "80-10-10" | "70-15-15" | "60-20-20";
type SplitTarget = "all" | "train" | "val" | "test";

function seededShuffle<T>(arr: T[], seed: string): T[] {
  const copy = [...arr];
  let s = [...seed].reduce((a, c) => a + c.charCodeAt(0), 0);
  for (let i = copy.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const j = Math.abs(s) % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function getSplitRatios(split: SplitRatio): [number, number] {
  switch (split) {
    case "80-10-10": return [0.8, 0.1];
    case "70-15-15": return [0.7, 0.15];
    case "60-20-20": return [0.6, 0.2];
    default:         return [1, 0];
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rateLimitRes = await checkRateLimit(aiLimiter, userId);
  if (rateLimitRes) return rateLimitRes;

  const { runId } = await params;
  const url = new URL(req.url);
  const format  = (url.searchParams.get("format")  ?? "raw_jsonl") as TrainingFormat;
  const split   = (url.searchParams.get("split")   ?? "none")      as SplitRatio;
  const target  = (url.searchParams.get("target")  ?? "all")       as SplitTarget;

  try {
    const run = await queryOneWithTeam<{
      processed_s3_key: string | null;
      file_format: string | null;
      mode: string | null;
    }>(
      userId,
      `SELECT pr.processed_s3_key, pr.file_format, pr.mode
       FROM pipeline_runs pr
       JOIN pipelines p ON pr.pipeline_id = p.id
       WHERE pr.id = $1 AND p.team_id = $2 AND pr.status = 'completed'`,
      [runId, userId]
    );

    if (!run?.processed_s3_key) {
      return NextResponse.json({ error: "No processed file found" }, { status: 404 });
    }

    if (run.mode === "document") {
      return NextResponse.json(
        { error: "Training export is available for tabular formats only (CSV, JSON, XLSX, etc.)" },
        { status: 400 }
      );
    }

    const obj = await s3.send(new GetObjectCommand({
      Bucket: requireEnv("S3_PROCESSED_BUCKET"),
      Key: run.processed_s3_key,
    }));

    const chunks: Uint8Array[] = [];
    for await (const chunk of obj.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
    const fileBytes = Buffer.concat(chunks);

    const fmt = deliverableFormat(run.processed_s3_key, run.file_format);
    const rows = parseDeliverableRows(fileBytes, fmt);
    if (!rows.length) return NextResponse.json({ error: "No rows found" }, { status: 400 });

    const shuffled = seededShuffle(rows, runId);
    const n = shuffled.length;
    const [trainRatio, valRatio] = getSplitRatios(split);
    const trainEnd = Math.floor(n * trainRatio);
    const valEnd   = trainEnd + Math.floor(n * valRatio);

    let selectedRows: Record<string, unknown>[];
    let splitLabel: string;

    if (split === "none") {
      selectedRows = shuffled;
      splitLabel   = "full";
    } else if (target === "train") {
      selectedRows = shuffled.slice(0, trainEnd);
      splitLabel   = "train";
    } else if (target === "val") {
      selectedRows = shuffled.slice(trainEnd, valEnd);
      splitLabel   = "val";
    } else if (target === "test") {
      selectedRows = shuffled.slice(valEnd);
      splitLabel   = "test";
    } else {
      // all: annotate with _split column
      selectedRows = [
        ...shuffled.slice(0, trainEnd).map((r) => ({ _split: "train", ...r })),
        ...shuffled.slice(trainEnd, valEnd).map((r) => ({ _split: "val",   ...r })),
        ...shuffled.slice(valEnd).map((r)            => ({ _split: "test",  ...r })),
      ];
      splitLabel = "all_splits";
    }

    const content  = toTrainingFormat(selectedRows, format);
    const fmtTag   = format === "raw_jsonl" ? "" : `_${format}`;
    const filename = `cleanstack_${runId.slice(0, 8)}${fmtTag}_${splitLabel}.jsonl`;

    return new Response(content, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    log.error("unhandled error", { err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
