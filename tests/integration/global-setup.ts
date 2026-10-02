// Fail fast (never skip) when the services are missing or not prepared.
import pg from "pg";
import { S3Client, GetBucketVersioningCommand } from "@aws-sdk/client-s3";
import { testEnv } from "../support/test-env.mjs";

export default async function setup() {
  const env = testEnv();
  Object.assign(process.env, env);
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  try {
    await client.connect();
    const { rows } = await client.query("SELECT to_regclass('public.pipeline_runs') AS t");
    if (!rows[0].t) throw new Error("schema not applied");
  } catch (e) {
    throw new Error(`Postgres not ready at ${env.DATABASE_URL} (${(e as Error).message}). Run: node tests/support/setup-services.mjs`);
  } finally {
    await client.end().catch(() => {});
  }
  const s3 = new S3Client({ region: env.AWS_REGION });
  for (const Bucket of [env.S3_RAW_BUCKET, env.S3_PROCESSED_BUCKET]) {
    const v = await s3.send(new GetBucketVersioningCommand({ Bucket })).catch((e) => {
      throw new Error(`LocalStack bucket ${Bucket} missing (${e.message}). Run: node tests/support/setup-services.mjs`);
    });
    if (v.Status !== "Enabled") throw new Error(`bucket ${Bucket} must have versioning enabled`);
  }
}
