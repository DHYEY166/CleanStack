import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { forbidGuest } from "@/lib/guest-guard";
import { queryOne } from "@/lib/db";
import type { PipelineTemplate } from "@/lib/types";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const guestRes = forbidGuest(userId);
  if (guestRes) return guestRes;

  const { id } = await params;

  const template = await queryOne<PipelineTemplate>(
    "SELECT * FROM pipeline_templates WHERE id = $1 AND is_public = true",
    [id]
  );
  if (!template) return NextResponse.json({ error: "Template not found" }, { status: 404 });

  // Create pipeline with template reference
  const pipeline = await queryOne<{ id: string }>(
    `INSERT INTO pipelines (name, description, owner_id, team_id, template_id)
     VALUES ($1, $2, $3, $3, $4)
     RETURNING id`,
    [
      `${template.name} (copy)`,
      template.description,
      userId,
      template.id,
    ]
  );
  if (!pipeline) return NextResponse.json({ error: "Failed to create pipeline" }, { status: 500 });

  // Increment template use count
  await queryOne(
    "UPDATE pipeline_templates SET use_count = use_count + 1 WHERE id = $1",
    [id]
  );

  return NextResponse.json({ pipeline_id: pipeline.id });
}
