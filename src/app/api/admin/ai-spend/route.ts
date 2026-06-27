import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { query } from "@/lib/db";

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function GET(req: NextRequest) {
  const expectedSecret = process.env.ADMIN_SECRET ?? "";
  if (!expectedSecret || !safeCompare(req.headers.get("x-admin-secret") ?? "", expectedSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await query<{
    team_id: string;
    total_cost: string;
    total_calls: string;
    input_tokens: string;
    output_tokens: string;
  }>(
    `SELECT team_id,
            ROUND(SUM(estimated_cost_usd)::numeric, 4) AS total_cost,
            COUNT(*) AS total_calls,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens
     FROM bedrock_usage
     WHERE created_at >= date_trunc('month', now())
     GROUP BY team_id
     ORDER BY total_cost DESC`
  );

  return NextResponse.json({ month: new Date().toISOString().slice(0, 7), rows });
}
