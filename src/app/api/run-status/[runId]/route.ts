import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { queryOne } from "@/lib/db";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { runId } = await params;

  try {
    const run = await queryOne<{
      id: string;
      status: string;
      pipeline_id: string;
      error_message: string | null;
      row_count_raw: number | null;
      row_count_processed: number | null;
    }>(
      `SELECT pr.id, pr.status, pr.pipeline_id, pr.error_message,
              pr.row_count_raw, pr.row_count_processed
       FROM pipeline_runs pr
       JOIN pipelines p ON pr.pipeline_id = p.id
       WHERE pr.id = $1 AND p.team_id = $2`,
      [runId, userId]
    );

    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    return NextResponse.json({ run });
  } catch (err) {
    console.error("[GET /api/run-status]", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
