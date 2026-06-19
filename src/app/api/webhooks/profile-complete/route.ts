import { NextRequest, NextResponse } from "next/server";
import { queryOne } from "@/lib/db";

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-webhook-secret");
  if (secret !== process.env.WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { run_id } = body;

  if (!run_id) return NextResponse.json({ error: "run_id required" }, { status: 400 });

  const run = await queryOne<{ id: string; pipeline_id: string; raw_s3_key: string }>(
    "SELECT id, pipeline_id, raw_s3_key FROM pipeline_runs WHERE id = $1",
    [run_id]
  );

  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  await queryOne(
    "UPDATE pipeline_runs SET status = 'awaiting_ai' WHERE id = $1",
    [run_id]
  );

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? `https://${req.headers.get("host")}`;
  const res = await fetch(`${baseUrl}/api/suggest-transforms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-webhook-secret": process.env.WEBHOOK_SECRET ?? "",
    },
    body: JSON.stringify({ run_id }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error(`[profile-complete] suggest-transforms ${res.status}: ${errBody}`);
  }

  return NextResponse.json({ ok: true });
}
