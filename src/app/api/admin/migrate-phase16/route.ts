import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export async function POST(req: Request) {
  if (req.headers.get("x-admin-secret") !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  await query(`
    ALTER TABLE pipeline_runs
      ADD COLUMN IF NOT EXISTS auto_mode BOOLEAN NOT NULL DEFAULT FALSE
  `);
  return NextResponse.json({ ok: true, message: "phase-16 migration complete" });
}
