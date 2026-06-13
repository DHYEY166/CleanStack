import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { query, queryOne } from "@/lib/db";
import type { PipelineTemplate, TemplateRule } from "@/lib/types";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const category = searchParams.get("category");

  const rows = await query<PipelineTemplate>(
    `SELECT * FROM pipeline_templates
     WHERE is_public = true
     ${category ? "AND category = $1" : ""}
     ORDER BY use_count DESC`,
    category ? [category] : []
  );

  return NextResponse.json({ templates: rows });
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { pipeline_id, name, description, category } = await req.json();
  if (!pipeline_id || !name) {
    return NextResponse.json({ error: "pipeline_id and name required" }, { status: 400 });
  }

  // Verify ownership
  const pipeline = await queryOne<{ id: string }>(
    "SELECT id FROM pipelines WHERE id = $1 AND team_id = $2",
    [pipeline_id, userId]
  );
  if (!pipeline) return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });

  // Grab approved rules from most recent completed run
  const rules = await query<TemplateRule>(
    `SELECT rule_type, column_name, parameters, ai_reasoning
     FROM transform_rules tr
     JOIN pipeline_runs pr ON tr.run_id = pr.id
     WHERE pr.pipeline_id = $1 AND tr.status = 'approved'
     ORDER BY pr.created_at DESC, tr.order_index ASC
     LIMIT 50`,
    [pipeline_id]
  );

  if (!rules.length) {
    return NextResponse.json({ error: "No approved rules found to save as template" }, { status: 422 });
  }

  const template = await queryOne<PipelineTemplate>(
    `INSERT INTO pipeline_templates
       (name, description, category, author_id, is_public, transform_rules)
     VALUES ($1, $2, $3, $4, false, $5)
     RETURNING *`,
    [name, description ?? null, category ?? null, userId, JSON.stringify(rules)]
  );

  return NextResponse.json({ template }, { status: 201 });
}
