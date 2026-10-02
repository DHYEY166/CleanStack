import { NextResponse } from "next/server";
import { safeCompare } from "@/lib/secrets";
import { query } from "@/lib/db";

export async function POST(req: Request) {
  const expectedSecret = process.env.ADMIN_SECRET ?? "";
  if (!expectedSecret || !safeCompare((req.headers as Headers).get("x-admin-secret") ?? "", expectedSecret)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  await query(`
    ALTER TABLE pipeline_runs
      ADD COLUMN IF NOT EXISTS auto_mode BOOLEAN NOT NULL DEFAULT FALSE
  `);
  return NextResponse.json({ ok: true, message: "phase-16 migration complete" });
}
