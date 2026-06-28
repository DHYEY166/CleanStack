import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { queryOneWithTeam } from "@/lib/db";

const ADMIN_USER_ID = "user_3FCqvsoBi9mTV2z9z9lka0DcaX12";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const adminSecret = req.headers.get("x-admin-secret");
  const userId = (adminSecret && adminSecret === process.env.ADMIN_SECRET)
    ? ADMIN_USER_ID
    : (await auth()).userId;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { runId } = await params;

  try {
    const run = await queryOneWithTeam<{
      id: string;
      status: string;
      pipeline_id: string;
      error_message: string | null;
      row_count_raw: number | null;
      row_count_processed: number | null;
      auto_mode: boolean;
    }>(
      userId,
      `SELECT pr.id, pr.status, pr.pipeline_id, pr.error_message,
              pr.row_count_raw, pr.row_count_processed, pr.auto_mode
       FROM pipeline_runs pr
       JOIN pipelines p ON pr.pipeline_id = p.id
       WHERE pr.id = $1 AND p.team_id = $2`,
      [runId, userId]
    );

    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    // If auto_mode and completed, look for a child run created by executor auto-iterate
    let child_run_id: string | null = null;
    if (run.auto_mode && run.status === "completed") {
      const child = await queryOneWithTeam<{ id: string }>(
        userId,
        "SELECT id FROM pipeline_runs WHERE parent_run_id = $1 ORDER BY created_at DESC LIMIT 1",
        [runId]
      );
      child_run_id = child?.id ?? null;
    }

    return NextResponse.json({ run, child_run_id });
  } catch (err) {
    console.error("[GET /api/run-status]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
