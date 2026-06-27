import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { queryOne, queryOneWithTeam } from "@/lib/db";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  try {
    const pipeline = await queryOneWithTeam<{ id: string }>(
      userId,
      "SELECT id FROM pipelines WHERE id = $1 AND team_id = $2",
      [id, userId]
    );

    if (!pipeline) {
      return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });
    }

    // Soft delete — keeps run history intact, dashboard query filters status != 'archived'
    await queryOne(
      "UPDATE pipelines SET status = 'archived' WHERE id = $1",
      [id]
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/pipelines/[id]]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
