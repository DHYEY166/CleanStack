import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { auth, currentUserEmail } from "@/lib/auth";
import { query, queryOne } from "@/lib/db";
import { isGuestId } from "@/lib/guest";
import { GUEST_LIMITS } from "@/lib/guest-limits";
import { GUEST_PIPELINE_INSERT_SQL, guestUploadRefusal, insertGuestRun } from "@/lib/guest-quota";
import { getCachedQuota } from "@/lib/quota-cache";
import { quotaBlockedMessage } from "@/lib/billing";
import { uploadLimiter, checkRateLimit } from "@/lib/rate-limit";
import { DEMO_TEMPLATE_ID, SAMPLE_CSV, SAMPLE_FILENAME } from "@/lib/sample-data";
import { requireEnv, awsRegion } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { Pipeline, PipelineRun } from "@/lib/types";

const log = logger.child({ route: "POST /api/sample-data" });

const s3 = new S3Client({ region: awsRegion() });

/**
 * "Try with sample data": creates a pipeline on the demo template (seeded by
 * migration 003) and writes the bundled CSV to the raw bucket server-side, so
 * the normal S3 event -> profiler -> suggest-transforms path runs. The
 * template path never calls Bedrock, so a sample run costs $0 in AI. It counts
 * as an upload (and a pipeline) for guests. Needs only s3:PutObject on the
 * raw bucket, which presigned uploads already require.
 */
export async function POST() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const guest = isGuestId(userId);

  try {
    const rateLimitRes = await checkRateLimit(uploadLimiter, userId);
    if (rateLimitRes) return rateLimitRes;

    const email = guest ? null : await currentUserEmail().catch(() => null);
    const quota = await getCachedQuota(userId, email, userId);
    if (quota.blocked) return NextResponse.json({ error: quotaBlockedMessage(quota) }, { status: 402 });

    const name = "Sample orders";
    const description = "Bundled sample data cleaned by a fixed template.";
    const pipeline = guest
      ? await queryOne<Pipeline>(GUEST_PIPELINE_INSERT_SQL, [name, description, userId, GUEST_LIMITS.pipelinesPerGuest, DEMO_TEMPLATE_ID])
      : await queryOne<Pipeline>(
          `INSERT INTO pipelines (name, description, owner_id, team_id, template_id)
           VALUES ($1, $2, $3, $3, $4) RETURNING *`,
          [name, description, userId, DEMO_TEMPLATE_ID]
        );
    if (!pipeline) {
      return NextResponse.json(
        { error: `Guests can create ${GUEST_LIMITS.pipelinesPerGuest} pipelines. Sign up to keep going.`, guest: true },
        { status: 429 }
      );
    }

    const runId = randomUUID();
    const s3Key = `${userId}/${pipeline.id}/${runId}/raw.csv`;
    const run = guest
      ? await insertGuestRun({ runId, pipelineId: pipeline.id, fileFormat: "csv", s3Key, guestId: userId })
      : await queryOne<PipelineRun>(
          `INSERT INTO pipeline_runs (id, pipeline_id, status, file_format, raw_s3_key, started_at)
           VALUES ($1, $2, 'pending', 'csv', $3, now()) RETURNING *`,
          [runId, pipeline.id, s3Key]
        );
    if (!run) {
      // Over the guest upload caps: do not leave an empty pipeline behind.
      await query("DELETE FROM pipelines WHERE id = $1 AND team_id = $2", [pipeline.id, userId]);
      return NextResponse.json({ error: await guestUploadRefusal(userId), guest: true }, { status: 429 });
    }

    try {
      await s3.send(new PutObjectCommand({
        Bucket: requireEnv("S3_RAW_BUCKET"), Key: s3Key, Body: SAMPLE_CSV, ContentType: "text/csv",
        Metadata: { filename: SAMPLE_FILENAME },
      }));
    } catch (err) {
      log.error("sample upload failed", { run_id: runId, err });
      await queryOne("UPDATE pipeline_runs SET status = 'failed', error_message = $2, updated_at = now() WHERE id = $1",
        [runId, "Could not store the sample file. Please retry."]);
      return NextResponse.json({ error: "Could not store the sample file. Please retry." }, { status: 500 });
    }

    return NextResponse.json({ pipeline_id: pipeline.id, run_id: runId }, { status: 201 });
  } catch (err) {
    log.error("sample data failed", { err });
    return NextResponse.json({ error: "Could not start the sample run. Please retry." }, { status: 500 });
  }
}
