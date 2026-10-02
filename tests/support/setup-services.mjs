#!/usr/bin/env node
// Prepare the local/CI service containers for the integration and e2e suites.
// Idempotent; safe to run repeatedly.
//
//   1. Postgres: apply src/lib/schema.sql + migrations (run-migration.mjs, DATABASE_URL path)
//   2. LocalStack S3: raw + processed buckets, versioning enabled (account
//      deletion must purge every version), CORS for the browser presigned PUT/GET
//   3. LocalStack SQS: executor queue + raw-events queue, and an S3 -> SQS
//      ObjectCreated notification on the raw bucket (stands in for the
//      profiler Lambda trigger; tests/e2e/lambda_worker.py consumes it)
//
// Usage: node tests/support/setup-services.mjs [--skip-db]
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  S3Client, CreateBucketCommand, PutBucketVersioningCommand, PutBucketCorsCommand,
  PutBucketNotificationConfigurationCommand, HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { SQSClient, CreateQueueCommand, GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { testEnv } from "./test-env.mjs";

const env = testEnv();
Object.assign(process.env, env);
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function retry(label, fn, attempts = 90) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= attempts) throw new Error(`${label}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

if (!process.argv.includes("--skip-db")) {
  const res = spawnSync(process.execPath, [join(root, "src/lib/migrations/run-migration.mjs")], {
    env: { ...process.env, DATABASE_URL: env.DATABASE_URL }, stdio: "inherit",
  });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

const s3 = new S3Client({ region: env.AWS_REGION });
const sqs = new SQSClient({ region: env.AWS_REGION });
const origins = [env.NEXT_PUBLIC_APP_URL];

for (const Bucket of [env.S3_RAW_BUCKET, env.S3_PROCESSED_BUCKET]) {
  await retry(`create ${Bucket}`, async () => {
    try { await s3.send(new HeadBucketCommand({ Bucket })); } catch { await s3.send(new CreateBucketCommand({ Bucket })); }
  });
  await s3.send(new PutBucketVersioningCommand({ Bucket, VersioningConfiguration: { Status: "Enabled" } }));
  await s3.send(new PutBucketCorsCommand({
    Bucket,
    CORSConfiguration: { CORSRules: [{ AllowedOrigins: origins, AllowedMethods: ["GET", "PUT", "HEAD"], AllowedHeaders: ["*"], ExposeHeaders: ["ETag"], MaxAgeSeconds: 600 }] },
  }));
}

const queueName = (url) => url.split("/").pop();
for (const url of [env.SQS_QUEUE_URL, env.RAW_EVENTS_QUEUE_URL]) {
  await retry(`create queue ${url}`, () => sqs.send(new CreateQueueCommand({ QueueName: queueName(url), Attributes: { VisibilityTimeout: "30" } })));
}
const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: env.RAW_EVENTS_QUEUE_URL, AttributeNames: ["QueueArn"] }));
await s3.send(new PutBucketNotificationConfigurationCommand({
  Bucket: env.S3_RAW_BUCKET,
  NotificationConfiguration: { QueueConfigurations: [{ QueueArn: Attributes.QueueArn, Events: ["s3:ObjectCreated:*"] }] },
}));

console.log(`services ready: buckets ${env.S3_RAW_BUCKET}, ${env.S3_PROCESSED_BUCKET} (versioned); queues ${queueName(env.SQS_QUEUE_URL)}, ${queueName(env.RAW_EVENTS_QUEUE_URL)}`);
