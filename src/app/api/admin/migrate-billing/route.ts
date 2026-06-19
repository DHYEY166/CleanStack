import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export async function POST(req: Request) {
  if (req.headers.get("x-admin-secret") !== process.env.ADMIN_SECRET) {
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
