import { auth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { query, queryOne, queryWithTeam } from "@/lib/db";
import type { Pipeline } from "@/lib/types";
import { logger } from "@/lib/logger";
import { isGuestId } from "@/lib/guest";
import { GUEST_LIMITS } from "@/lib/guest-limits";
import { GUEST_PIPELINE_INSERT_SQL } from "@/lib/guest-quota";

const log = logger.child({ route: "/api/pipelines" });

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
    log.error("GET failed", { err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
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
    if (isGuestId(userId)) {
      const pipeline = await queryOne<Pipeline>(GUEST_PIPELINE_INSERT_SQL,
        [name.trim(), description?.trim() || null, userId, GUEST_LIMITS.pipelinesPerGuest]);
      if (!pipeline) {
        return NextResponse.json(
          { error: `Guests can create ${GUEST_LIMITS.pipelinesPerGuest} pipelines. Sign up to keep going.`, guest: true },
          { status: 429 }
        );
      }
      return NextResponse.json({ pipeline }, { status: 201 });
    }
    const pipeline = await queryOne<Pipeline>(
      `INSERT INTO pipelines (name, description, owner_id, team_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name.trim(), description?.trim() || null, userId, userId]
    );
    return NextResponse.json({ pipeline }, { status: 201 });
  } catch (err) {
    log.error("POST failed", { err });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
