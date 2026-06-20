import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { query, queryOne, queryWithTeam } from "@/lib/db";
import type { Pipeline } from "@/lib/types";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const pipelines = await queryWithTeam<Pipeline>(
      userId,
      "SELECT * FROM pipelines WHERE team_id = $1 AND status != 'archived' ORDER BY created_at DESC",
      [userId]
    );
    return NextResponse.json({ pipelines });
  } catch (err) {
    console.error("[GET /api/pipelines]", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { name, description } = body;

  if (!name?.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  try {
    const pipeline = await queryOne<Pipeline>(
      `INSERT INTO pipelines (name, description, owner_id, team_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name.trim(), description?.trim() || null, userId, userId]
    );
    return NextResponse.json({ pipeline }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/pipelines]", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
