# Deployment

Vercel deploys the web app from `main`. Everything else in this guide is configured by hand in AWS, because the repo has no infrastructure as code. Replace `<...>` with your own values.

## Web app (Vercel)

Vercel runs `npm run build` on every push to `main`. The build needs no secrets, because configuration is validated per request. Set the variables from `src/lib/env.ts` in the Vercel project. The AWS SDK reads its credentials from the standard `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` variables, which belong to the `cleanstack-vercel` IAM user (see [IAM](#iam)).

## Database migrations

Apply migrations **before** you deploy code that depends on them. Every statement is idempotent, so you can re-run them safely.

| Migration | Creates |
|---|---|
| `001_indexes.sql` | Hot-path indexes (`CREATE INDEX CONCURRENTLY`) |
| `002_ai_usage_tables.sql` | `bedrock_usage`, `ai_spend_limits`. AI metering and spend caps need these tables |
| `003_guest_sessions.sql` | `guest_sessions`, an index on `bedrock_usage(created_at)` and the demo template. `POST /api/guest` returns 500 without it |

**Option A**, from a machine that can reach the cluster (IAM auth). This also applies `schema.sql` on a fresh database:

```bash
AURORA_HOST=<cluster endpoint> RDS_CA_BUNDLE=/path/to/global-bundle.pem \
  node src/lib/migrations/run-migration.mjs        # MIGRATIONS_ONLY=1 skips schema.sql
```

**Option B**, from AWS CloudShell through the RDS Data API. Upload the `.sql` files first. The script runs one statement per call, split the same way as `run-migration.mjs`:

```bash
python3 - <<'PY'
import boto3, pathlib
rds = boto3.client("rds-data", region_name="us-east-1")
CLUSTER, SECRET = "<cluster ARN>", "<DB secret ARN>"
for f in ["001_indexes.sql", "002_ai_usage_tables.sql", "003_guest_sessions.sql"]:
    lines = pathlib.Path(f).read_text().splitlines()
    sql = "\n".join(l for l in lines if not l.strip().startswith("--"))
    for stmt in filter(None, (s.strip() for s in sql.split(";"))):
        rds.execute_statement(resourceArn=CLUSTER, secretArn=SECRET, database="cleanstack", sql=stmt)
    print("applied", f)
PY
```

## Lambdas

There is no build or deploy script. Each function is deployed as its `handler.py` plus its pinned `requirements.txt` (ai-trigger has no dependencies beyond the standard library). The profiler and executor also attach the `AWSSDKPandas-Python312` layer, which provides pandas and numpy. The code is tested on pandas 2.2.3 and 3.0.6.

All functions are in `us-east-1`:

| Code | Function |
|---|---|
| `lambdas/profiler/handler.py` | `cleanstack-profiler` |
| `lambdas/executor/handler.py` | `cleanstack-executor` |
| `lambdas/ai-trigger/handler.py` | `cleanstack-ai-trigger` |
| `lambdas/drift/handler.py` | `cleanstack-drift` |

**Zip-swap (CloudShell).** When only `handler.py` changed, keep the deployed package and replace the handler. Upload each changed `handler.py` to CloudShell as `<name>/handler.py` (for example `executor/handler.py`), then run:

```bash
for name in profiler executor ai-trigger drift; do     # keep only the ones you changed
  FN="cleanstack-$name"
  curl -s -o current.zip "$(aws lambda get-function --function-name "$FN" --region us-east-1 --query Code.Location --output text)"
  rm -rf pkg && mkdir pkg && unzip -q current.zip -d pkg
  cp "$name/handler.py" pkg/handler.py
  (cd pkg && rm -f ../new.zip && zip -qr ../new.zip .)
  aws lambda update-function-code --function-name "$FN" --region us-east-1 --zip-file fileb://new.zip >/dev/null
  aws lambda wait function-updated --function-name "$FN" --region us-east-1 && echo "deployed $FN"
done
```

If `requirements.txt` changed, rebuild the package with `pip install -r requirements.txt -t pkg` instead, leaving out pandas and numpy, which come from the layer.

### Lambda environment

| Function | Variables |
|---|---|
| profiler | `DATABASE_URL` (host, user and database; the password is an IAM token), `APP_URL`, `WEBHOOK_SECRET`, `MAX_UPLOAD_MB` (default 100; keep it equal to the web app's), `SENTRY_DSN`, `AWS_REGION` |
| ai-trigger | `APP_URL`, `WEBHOOK_SECRET` |
| executor | `DB_SECRET_ARN`, `S3_RAW_BUCKET`, `S3_PROCESSED_BUCKET`, `SNS_DRIFT_TOPIC_ARN`, `EXECUTOR_MAX_ATTEMPTS` (default 3), `SEMANTIC_DEDUP_MAX_ROWS` (default 500000), `SEMANTIC_DEDUP_BUDGET_S` (default 600), `EXECUTOR_RESERVE_S` (default 120), `SENTRY_DSN`, `AWS_REGION` |
| drift | `DB_SECRET_ARN`, `AWS_REGION` |

The profiler, ai-trigger and web app must share the same `WEBHOOK_SECRET`.

## AWS setup

**S3**

- **Raw bucket CORS:** allow `PUT`, `GET` and `POST` from the app origin. Uploads are presigned POSTs, and their `content-length-range` policy makes S3 reject oversized files.
- **Profiler trigger:** a raw bucket event notification on **All object create events** (`s3:ObjectCreated:*`). A trigger on `Put` alone never fires for browser uploads, so runs stay in `pending`.
- **Processed bucket CORS:** allow `GET` from the app origin. **Export As** fetches the presigned URL from the browser.
- **Lifecycle rule (raw bucket):** expire current and noncurrent versions under prefix `guest_` after 1 day. This is a backstop in case the guest purge stops.

**SQS**

- **Executor queue (`cleanstack-jobs`):** triggers the executor. Set the visibility timeout to at least the executor's timeout (AWS recommends 6×), and add a dead-letter queue with `maxReceiveCount` ≥ `EXECUTOR_MAX_ATTEMPTS`. `BatchSize: 1` keeps retries simple.
- **AI jobs queue:** triggers ai-trigger. It is used only when `AI_QUEUE_ENABLED=true`.

**EventBridge schedules.** Both cron routes are `GET` and require `Authorization: Bearer $CRON_SECRET`. `vercel.json` defines no crons, because Vercel Hobby crons run at most once a day. Instead, EventBridge rules call the routes through API destinations. Both destinations share the connection `cleanstack-reconciler-auth`, which sends that header. Both rules run as the role `cleanstack-eventbridge-invoker`. That role has one inline policy per destination, granting `events:InvokeApiDestination`: the original reconciler policy, plus `invoke-purge-guests`.

| Rule | Schedule | API destination | Route |
|---|---|---|---|
| `cleanstack-reconciler-5min` | `rate(5 minutes)` | `cleanstack-reconciler-destination` | `/api/cron/reconcile-runs`: marks runs stuck for 20 minutes as `failed` |
| `cleanstack-purge-guests-hourly` | `rate(1 hour)` | `cleanstack-purge-guests-destination` | `/api/cron/purge-guests`: erases up to 20 expired guests per call |

If you rotate `CRON_SECRET`, update the connection `cleanstack-reconciler-auth` at the same time as Vercel.

## IAM

**`cleanstack-vercel` (web app user)**, least privilege, based on the calls in `src/`:

| Service | Actions | Resource |
|---|---|---|
| S3 | `s3:PutObject` | raw bucket (presigned POST, sample data, iteration copies) |
| S3 | `s3:GetObject` | processed bucket (downloads, Export As, training export, iteration copy source) |
| S3 | `s3:ListBucket`, `s3:ListBucketVersions`, `s3:DeleteObject`, `s3:DeleteObjectVersion` | both buckets (account deletion and the guest purge) |
| SQS | `sqs:SendMessage` | `cleanstack-jobs` (executor) and the AI jobs queue |
| RDS Data API | `rds-data:ExecuteStatement`, `BeginTransaction`, `CommitTransaction`, `RollbackTransaction` | the cluster |
| Secrets Manager | `secretsmanager:GetSecretValue` | the DB secret |
| Bedrock | `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream` (the chat builder streams) | the inference profile in `src/lib/ai-config.ts` and the foundation models it routes to |

If the buckets use SSE-KMS, the user also needs `kms:GenerateDataKey` and `kms:Decrypt` on the key.

**Lambda roles**, in addition to the basic execution role and their trigger permissions:

- **profiler:** `s3:GetObject` and `s3:PutObject` (for `extracted_text.txt`) on the raw bucket, and `rds-db:connect` for its database user.
- **executor:** `s3:GetObject`, `s3:ListBucketVersions`, `s3:DeleteObject` and `s3:DeleteObjectVersion` on the raw bucket, `s3:PutObject` on the processed bucket, `secretsmanager:GetSecretValue` on the DB secret, `rds-db:connect`, and `sns:Publish` on the drift topic. Without `s3:ListBucketVersions`, the executor deletes only the run's two known raw keys.
- **drift:** `secretsmanager:GetSecretValue`, `rds-db:connect` and outbound HTTPS to `hooks.slack.com`.
- **ai-trigger:** no AWS API calls beyond its SQS trigger.
