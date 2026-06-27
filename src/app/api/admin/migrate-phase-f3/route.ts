import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { query } from "@/lib/db";

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function POST(req: Request) {
  const expectedSecret = process.env.ADMIN_SECRET ?? "";
  if (!expectedSecret || !safeCompare((req.headers as Headers).get("x-admin-secret") ?? "", expectedSecret)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  await query(`
    ALTER TABLE pipeline_runs
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  `);
  // Backfill: set updated_at = created_at for all existing rows so reconciler doesn't immediately fail them
  await query(`
    UPDATE pipeline_runs SET updated_at = created_at WHERE updated_at = now() AND created_at < now() - INTERVAL '5 seconds'
  `);
  return NextResponse.json({ ok: true, message: "phase-F3 migration complete: updated_at column added" });
}
