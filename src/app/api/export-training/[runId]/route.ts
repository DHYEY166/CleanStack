import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { queryOne } from "@/lib/db";

const s3 = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });

type TrainingFormat = "raw_jsonl" | "alpaca" | "chat";
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

function parseToRows(bytes: Buffer, fmt: string): Record<string, unknown>[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const XLSX = require("xlsx");

  if (fmt === "json") {
    const parsed = JSON.parse(bytes.toString("utf-8"));
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  if (fmt === "jsonl") {
    return bytes.toString("utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  if (fmt === "tsv") {
    const lines = bytes.toString("utf-8").trim().split("\n").filter(Boolean);
    const headers = lines[0].split("\t");
    return lines.slice(1).map((l) => {
      const vals = l.split("\t");
      return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? ""]));
    });
  }
  if (fmt === "xlsx" || fmt === "xls") {
    const wb = XLSX.read(bytes, { type: "buffer" });
    return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]) as Record<string, unknown>[];
  }
  // csv / txt — use xlsx CSV parser
  const wb = XLSX.read(bytes, { type: "buffer", raw: false });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]) as Record<string, unknown>[];
}

function toTrainingFormat(rows: Record<string, unknown>[], fmt: TrainingFormat): string {
  if (fmt === "alpaca") {
    return rows.map((row) => JSON.stringify({
      instruction: "Process and analyze this data record.",
      input: JSON.stringify(row),
      output: "",
    })).join("\n");
  }
  if (fmt === "chat") {
    return rows.map((row) => JSON.stringify({
      messages: [
        { role: "user", content: JSON.stringify(row) },
        { role: "assistant", content: "" },
      ],
    })).join("\n");
  }
  return rows.map((row) => JSON.stringify(row)).join("\n");
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

  const { runId } = await params;
  const url = new URL(req.url);
  const format  = (url.searchParams.get("format")  ?? "raw_jsonl") as TrainingFormat;
  const split   = (url.searchParams.get("split")   ?? "none")      as SplitRatio;
  const target  = (url.searchParams.get("target")  ?? "all")       as SplitTarget;

  try {
    const run = await queryOne<{
      processed_s3_key: string | null;
      file_format: string | null;
      mode: string | null;
    }>(
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
      Bucket: process.env.S3_PROCESSED_BUCKET!,
      Key: run.processed_s3_key,
    }));

    const chunks: Uint8Array[] = [];
    for await (const chunk of obj.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
    const fileBytes = Buffer.concat(chunks);

    const fmt = run.file_format ?? "csv";
    const rows = parseToRows(fileBytes, fmt);
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
    console.error("[export-training]", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
