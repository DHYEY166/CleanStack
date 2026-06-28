import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { query, queryOne, queryOneWithTeam, withTransaction } from "@/lib/db";

interface RuleDecision {
  rule_id: string;
  action: "approved" | "rejected";
  modifications: Record<string, unknown> | null;
}

const sqs = new SQSClient({ region: process.env.AWS_REGION ?? "us-east-1" });

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { run_id, rule_decisions } = body as {
    run_id: string;
    rule_decisions: RuleDecision[];
  };

  if (!run_id || !Array.isArray(rule_decisions)) {
    return NextResponse.json({ error: "run_id and rule_decisions required" }, { status: 400 });
  }
  if (rule_decisions.length > 100) {
    return NextResponse.json({ error: "Too many rule decisions (max 100)" }, { status: 400 });
  }
  const invalidDecision = rule_decisions.find(
    (d) => typeof d.rule_id !== "string" || !["approved", "rejected"].includes(d.action)
  );
  if (invalidDecision) {
    return NextResponse.json({ error: "Invalid rule_decision: rule_id must be string, action must be approved|rejected" }, { status: 400 });
  }

  try {
    const run = await queryOneWithTeam<{ id: string; pipeline_id: string; status: string }>(
      userId,
      `SELECT pr.id, pr.pipeline_id, pr.status
       FROM pipeline_runs pr
       JOIN pipelines p ON pr.pipeline_id = p.id
       WHERE pr.id = $1 AND p.team_id = $2`,
      [run_id, userId]
    );

    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
    if (run.status !== "awaiting_approval") {
      return NextResponse.json({ error: "Run is not awaiting approval" }, { status: 409 });
    }

    // Wrap rule updates + audit insert + run status in a single transaction
    const approvedCount = await withTransaction(async (txId) => {
      for (const d of rule_decisions) {
        const params = d.modifications ? JSON.stringify(d.modifications) : null;
        await query(
          `UPDATE transform_rules
           SET status = $2${params ? ", parameters = $3" : ""}
           WHERE id = $1 AND run_id = $${params ? "4" : "3"}`,
          params ? [d.rule_id, d.action, params, run_id] : [d.rule_id, d.action, run_id],
          txId
        );
      }

      const ruleChanges = Object.fromEntries(
        rule_decisions.map((d) => [d.rule_id, { action: d.action, modifications: d.modifications }])
      );

      await queryOne(
        `INSERT INTO approval_reviews (run_id, reviewer_id, action, rule_changes)
         VALUES ($1, $2, 'approved', $3)`,
        [run_id, userId, JSON.stringify(ruleChanges)],
        txId
      );

      const count = rule_decisions.filter((d) => d.action === "approved").length;

      // Set run status inside transaction — reconciler cron will retry SQS if send fails below
      if (count > 0 && process.env.SQS_QUEUE_URL) {
        await queryOne("UPDATE pipeline_runs SET status = 'queued', updated_at = now() WHERE id = $1", [run_id], txId);
      } else {
        await queryOne("UPDATE pipeline_runs SET status = 'completed', updated_at = now() WHERE id = $1", [run_id], txId);
      }

      return count;
    });

    if (approvedCount > 0 && process.env.SQS_QUEUE_URL) {
      try {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: process.env.SQS_QUEUE_URL,
            MessageBody: JSON.stringify({ run_id }),
          })
        );
      } catch (sqsErr) {
        // Status already 'queued' in DB — reconciler cron will retry SQS delivery
        console.error("[approve-rules] SQS send failed (reconciler will retry):", sqsErr);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[POST /api/approve-rules]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
