import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";
import { queryOne, query } from "@/lib/db";
import type { PipelineRun, TransformRule } from "@/lib/types";
import ReviewClient from "./ReviewClient";

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string; rid: string }>;
}) {
  const { userId } = await auth();
  const { id, rid } = await params;

  const run = await queryOne<PipelineRun & { pipeline_name: string }>(
    `SELECT pr.*, p.name AS pipeline_name
     FROM pipeline_runs pr
     JOIN pipelines p ON pr.pipeline_id = p.id
     WHERE pr.id = $1 AND p.team_id = $2`,
    [rid, userId]
  );
  if (!run) notFound();

  if (run.status !== "awaiting_approval") {
    redirect(`/pipelines/${id}/runs/${rid}`);
  }

  const rules = await query<TransformRule>(
    "SELECT * FROM transform_rules WHERE run_id = $1 AND status = 'pending' ORDER BY order_index ASC",
    [rid]
  );

  return (
    <ReviewClient
      pipelineId={id}
      run={run}
      rules={rules}
    />
  );
}
