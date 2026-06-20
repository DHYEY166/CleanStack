import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { queryOne, queryOneWithTeam } from "@/lib/db";

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { pipeline_id, slack_webhook_url } = await req.json();
  if (!pipeline_id) {
    return NextResponse.json({ error: "pipeline_id required" }, { status: 400 });
  }

  // Verify ownership
  const pipeline = await queryOneWithTeam<{ id: string }>(
    userId,
    "SELECT id FROM pipelines WHERE id = $1 AND team_id = $2",
    [pipeline_id, userId]
  );
  if (!pipeline) return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });

  if (!slack_webhook_url) {
    // Deactivate existing alert
    await queryOne(
      "UPDATE pipeline_destinations SET is_active = false WHERE pipeline_id = $1 AND type = 'slack_alert'",
      [pipeline_id]
    );
    return NextResponse.json({ ok: true, action: "disabled" });
  }

  // Upsert slack_alert destination
  await queryOne(
    `INSERT INTO pipeline_destinations (pipeline_id, type, config, is_active)
     VALUES ($1, 'slack_alert', $2, true)
     ON CONFLICT DO NOTHING`,
    [pipeline_id, JSON.stringify({ webhook_url: slack_webhook_url })]
  );

  // If ON CONFLICT did nothing (row exists), update it
  await queryOne(
    `UPDATE pipeline_destinations
     SET config = $2, is_active = true
     WHERE pipeline_id = $1 AND type = 'slack_alert'`,
    [pipeline_id, JSON.stringify({ webhook_url: slack_webhook_url })]
  );

  return NextResponse.json({ ok: true, action: "configured" });
}

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const pipeline_id = searchParams.get("pipeline_id");
  if (!pipeline_id) return NextResponse.json({ error: "pipeline_id required" }, { status: 400 });

  const dest = await queryOne<{ config: Record<string, string>; is_active: boolean }>(
    `SELECT config, is_active FROM pipeline_destinations
     WHERE pipeline_id = $1 AND type = 'slack_alert'
     LIMIT 1`,
    [pipeline_id]
  );

  return NextResponse.json({
    configured: !!dest?.is_active,
    webhook_url: dest?.is_active ? (dest.config as { webhook_url?: string }).webhook_url : null,
  });
}
