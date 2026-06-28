import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { queryOneWithTeam } from "@/lib/db";

const s3 = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });

const MIME: Record<string, { contentType: string; ext: string }> = {
  csv:  { contentType: "text/csv",                                                          ext: "csv"  },
  txt:  { contentType: "text/plain",                                                         ext: "txt"  },
  tsv:  { contentType: "text/tab-separated-values",                                         ext: "tsv"  },
  json: { contentType: "application/json",                                                  ext: "json" },
  jsonl:{ contentType: "application/x-ndjson",                                              ext: "jsonl"},
  xlsx: { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" },
  xls:  { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" },
  xml:  { contentType: "application/xml",                                                   ext: "xml"  },
  pdf:  { contentType: "application/pdf",                                                                                   ext: "pdf"  },
  docx: { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",                          ext: "docx" },
};

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

    const obj = await s3.send(
      new GetObjectCommand({
        Bucket: process.env.S3_PROCESSED_BUCKET!,
        Key: run.processed_s3_key,
      })
    );

    const chunks: Uint8Array[] = [];
    const stream = obj.Body as AsyncIterable<Uint8Array>;
    for await (const chunk of stream) chunks.push(chunk);
    let fileBytes = Buffer.concat(chunks);

    const fmt = run.file_format ?? "csv";

    // Strip __orig_* audit columns from CSV/TSV before delivering to user
    if (fmt === "csv" || fmt === "tsv") {
      const sep = fmt === "tsv" ? "\t" : ",";
      const text = fileBytes.toString("utf-8");
      const lines = text.split("\n");
      if (lines.length > 0) {
        const headers = lines[0].split(sep);
        const keepIdx = headers
          .map((h, i) => ({ h: h.replace(/^"|"$/g, ""), i }))
          .filter(({ h }) => !h.startsWith("__orig_"))
          .map(({ i }) => i);
        if (keepIdx.length < headers.length) {
          const cleaned = lines.map((line) => {
            if (!line.trim()) return line;
            const cells = line.split(sep);
            return keepIdx.map((i) => cells[i] ?? "").join(sep);
          });
          fileBytes = Buffer.from(cleaned.join("\n"), "utf-8");
        }
      }
    }

    const mime = MIME[fmt] ?? MIME["csv"];

    return new NextResponse(fileBytes, {
      headers: {
        "Content-Type": mime.contentType,
        "Content-Disposition": `attachment; filename="cleanstack_${runId.slice(0, 8)}.${mime.ext}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[GET /api/download]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
