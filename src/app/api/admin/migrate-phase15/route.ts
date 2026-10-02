import { NextResponse } from "next/server";
import { safeCompare } from "@/lib/secrets";
import { query } from "@/lib/db";
import { optionalEnv } from "@/lib/env";

export async function POST(req: Request) {
  const expectedSecret = optionalEnv("ADMIN_SECRET") ?? "";
  if (!expectedSecret || !safeCompare((req.headers as Headers).get("x-admin-secret") ?? "", expectedSecret)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await query(`
    ALTER TABLE pipeline_runs
      ADD COLUMN IF NOT EXISTS iteration INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS parent_run_id UUID REFERENCES pipeline_runs(id) ON DELETE SET NULL
  `);

  return NextResponse.json({ ok: true, message: "phase-15 migration complete" });
}
