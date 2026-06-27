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
    CREATE TABLE IF NOT EXISTS subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      team_id TEXT NOT NULL UNIQUE,
      plan TEXT NOT NULL DEFAULT 'free',
      status TEXT NOT NULL DEFAULT 'active',
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      current_period_start TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', now()),
      current_period_end TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_subscriptions_team_id ON subscriptions(team_id)
  `);

  return NextResponse.json({ ok: true, message: "billing migration complete — subscriptions table created" });
}
