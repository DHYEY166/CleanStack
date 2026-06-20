import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { queryOne } from "@/lib/db";
import { PLANS, type PlanId } from "@/lib/billing";

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function POST(req: Request) {
  if (!safeCompare(req.headers.get("x-admin-secret") ?? "", process.env.ADMIN_SECRET ?? "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { team_id, plan } = await req.json();

  if (!team_id) {
    return NextResponse.json({ error: "team_id required" }, { status: 400 });
  }
  if (!plan || !(plan in PLANS)) {
    return NextResponse.json(
      { error: `plan must be one of: ${Object.keys(PLANS).join(", ")}` },
      { status: 400 }
    );
  }

  const row = await queryOne(
    `INSERT INTO subscriptions (team_id, plan, status, current_period_start)
     VALUES ($1, $2, 'active', date_trunc('month', now()))
     ON CONFLICT (team_id)
     DO UPDATE SET plan = $2, updated_at = now()
     RETURNING team_id, plan`,
    [team_id, plan as PlanId]
  );

  return NextResponse.json({ ok: true, subscription: row });
}
