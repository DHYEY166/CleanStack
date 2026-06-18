import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export async function POST(req: Request) {
  const secret = req.headers.get("x-admin-secret");
  if (secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await query(`
    ALTER TABLE pipeline_runs
      ADD COLUMN IF NOT EXISTS iteration INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS parent_run_id UUID REFERENCES pipeline_runs(id) ON DELETE SET NULL
  `);

  return NextResponse.json({ ok: true, message: "phase-15 migration complete" });
}
