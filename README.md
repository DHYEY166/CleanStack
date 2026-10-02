# CleanStack

CleanStack is a web app for cleaning tabular files and documents with an AI-reviewed, human-approved workflow. You upload a file and a Lambda profiles it. Claude (via Amazon Bedrock) then proposes transform rules with reasons, and you approve or reject each one in a "Data PR". Another Lambda applies the approved rules with pandas and returns a cleaned file with a before/after quality score.

[![Demo video](public/demo-thumb.png)](https://youtu.be/rhsA_740Zgs) · Live deployment: [clean-stack-eta.vercel.app](https://clean-stack-eta.vercel.app)

- [Architecture](#architecture)
- [Run it locally](#run-it-locally)
- [Run the tests](#run-the-tests)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Operations runbook](#operations-runbook)
- [Security model](#security-model)
- [Known limitations](#known-limitations)
- [Transform rules](#transform-rules)

---

## Architecture

```
Browser ── Next.js 16 app on Vercel (Clerk auth, API routes) ── Aurora PostgreSQL (RDS Data API)
   │                │
   │ presigned PUT  │ presigned GET (120 s) for downloads
   ▼                ▼
S3 raw bucket    S3 processed bucket  (output.<ext> + audit.csv per run)
   │ S3 event
   ▼
Lambda: profiler ── stats + quality score → data_profiles ── POST /api/webhooks/profile-complete
                                                                 │
               AI_QUEUE_ENABLED=true: SQS ai-jobs → Lambda ai-trigger ┐
               otherwise: inline call ───────────────────────────────┤
                                                                     ▼
                                       /api/suggest-transforms (Bedrock) → transform_rules
                                                                     │
                     manual: Data PR review → /api/approve-rules     │ auto: /api/auto-validate
                                                                     ▼   (3-persona committee)
                                                         SQS executor queue
                                                                     │
Lambda: executor ── claims run, applies rules, writes deliverable + audit file,
                    re-scores output, deletes raw run objects, optional next pass
                    └─ schema changed → SNS → Lambda: drift → Slack webhook
```

| Component | Where it lives | Notes |
|---|---|---|
| Web app + API | `src/` (Next.js App Router) | Deployed on Vercel |
| Profiler Lambda | `lambdas/profiler/handler.py` | S3 PUT trigger |
| AI trigger Lambda | `lambdas/ai-trigger/handler.py` | SQS trigger, calls `/api/suggest-transforms` |
| Executor Lambda | `lambdas/executor/handler.py` | SQS trigger |
| Drift Lambda | `lambdas/drift/handler.py` | SNS trigger |
| Schema | `src/lib/schema.sql`, `src/lib/migrations/NNN_*.sql` | Applied by `run-migration.mjs` |
| AWS resources (buckets, queues, IAM, KMS, Lambda config, cron schedule) | **Not in this repo** | Configured by hand in the AWS console; see [Known limitations](#known-limitations) |

### Run lifecycle

`pending` (presigned URL issued) → `profiling` → `awaiting_ai` → `awaiting_approval` → `queued` → `running` → `completed` / `failed`.

- **Execution is idempotent per run.** The executor moves a run from `queued` to `running` with a conditional `UPDATE`. A duplicate SQS delivery is acknowledged and skipped. A `running` lease older than 15 minutes, which is Lambda's hard limit, can be reclaimed.
- **Rules are all-or-nothing.** The executor snapshots the frame before each rule. If a rule fails or is unsafe (unknown type, missing column, more than 20% row loss, bad regex, cast that would lose data), the frame is restored and the rule is recorded as *not applied* with a reason in `transform_rules.parameters._execution`. The run page shows those rules as "Not applied".
- **Deliverables never contain audit columns.** Rules that rewrite values keep the original in an `__orig_<column>` sidecar. Sidecars are written only to `processed/{pipeline}/{run}/audit.csv`, next to `output.<ext>`.
- **The quality score is computed the same way before and after.** The profiler and executor share one loader and scorer (the `SHARED QUALITY BLOCK`, enforced by a test), and the executor scores the bytes it actually wrote.

---

## Run it locally

Prerequisites: Node.js 20 or 22, npm, Python 3.12 (for the Lambda tests), and an AWS account with the resources in [Configuration](#configuration). The UI cannot do anything useful without Aurora, S3, SQS, Bedrock and Clerk. There is no local mock stack.

```bash
git clone https://github.com/DHYEY166/CleanStack.git
cd CleanStack
npm ci
cp .env.example .env.local     # fill in real values
npm run dev                    # http://localhost:3000
```

When the server starts it logs one `invalid or missing environment` line listing any required variable that is missing or malformed (see `src/lib/env.ts`).

Database (first time, and after pulling new migrations):

```bash
AURORA_HOST=<cluster endpoint> RDS_CA_BUNDLE=/path/to/global-bundle.pem \
  node src/lib/migrations/run-migration.mjs
```

This applies `schema.sql` and then every `src/lib/migrations/NNN_*.sql` in order. Every statement is idempotent, so re-running is safe. It authenticates with an RDS IAM token for `AURORA_USER` (default `postgres`). Optional seed data is in `src/lib/seed-templates.sql`.

## Run the tests

The same commands as CI (`ci/verify.sh` runs all of them):

```bash
npm ci
npx eslint
npx tsc --noEmit
npx vitest run          # TypeScript unit tests (src/**/*.test.ts)
npm run build

python3.12 -m venv .venv && . .venv/bin/activate
pip install -r lambdas/requirements-dev.txt
python -m pytest -q lambdas/tests
```

The Lambda tests import the real handlers. AWS clients are created but never called, and DB and S3 are faked inside the tests. CI runs them against both pandas 2.2.3 (pinned) and pandas 3.0.6.

The workflow definition is `ci/github-actions-ci.yml`. It is **not active yet** because GitHub only runs workflows from `.github/workflows/`. To enable it, move the file there (`git mv ci/github-actions-ci.yml .github/workflows/ci.yml`) with a token that has the `workflow` scope.

---

## Configuration

### Web app (Vercel / `.env.local`)

The full contract is in `src/lib/env.ts`, and `.env.example` has a placeholder for every variable. A test fails if one is missing from `.env.example`.

| Variable | Required | Purpose |
|---|---|---|
| `AWS_REGION` | no (default `us-east-1`) | Region for S3, SQS, RDS Data API, Bedrock |
| `AURORA_CLUSTER_ARN` | yes | Aurora cluster ARN (RDS Data API) |
| `AURORA_SECRET_ARN` | yes | Secrets Manager ARN of the DB credentials |
| `S3_RAW_BUCKET` | yes | Raw uploads |
| `S3_PROCESSED_BUCKET` | yes | Deliverables and audit files |
| `SQS_QUEUE_URL` | yes | Executor queue. If unset, approved runs are marked completed **without executing** |
| `AI_QUEUE_ENABLED` | no | `true` = enqueue AI jobs to `AI_JOBS_QUEUE_URL`; otherwise `profile-complete` calls `suggest-transforms` inline |
| `AI_JOBS_QUEUE_URL` | when `AI_QUEUE_ENABLED=true` | AI jobs queue |
| `NEXT_PUBLIC_APP_URL` | yes | Base URL for internal webhook calls |
| `WEBHOOK_SECRET` | yes | Shared with the profiler and ai-trigger Lambdas (`x-webhook-secret`) |
| `CRON_SECRET` | yes | `Authorization: Bearer` for `/api/cron/reconcile-runs` |
| `ADMIN_SECRET` | no | `x-admin-secret` for `/api/admin/*`; those routes return 401 when unset |
| `ADMIN_EMAILS`, `ADMIN_USER_IDS` | no | Users who bypass billing quotas |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | yes | Clerk |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | no | Rate limiting and quota cache. **Both are off when unset (fail open)** |
| `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` | no | Error reporting |
| `LOG_LEVEL` | no (default `info`) | Threshold of the JSON logger |

Generate shared secrets with `openssl rand -hex 32`. Values shorter than 32 characters produce a startup warning.

The Bedrock model id and the token prices used for metering are in `src/lib/ai-config.ts`. Today that is `us.anthropic.claude-sonnet-4-6` at $3 / $15 per 1M input/output tokens. Update both in the same commit when changing models.

### Lambdas (set on each function)

| Function | Variables read by the code |
|---|---|
| profiler | `DATABASE_URL`, `APP_URL`, `WEBHOOK_SECRET`, `SENTRY_DSN` (optional), `AWS_REGION` |
| ai-trigger | `APP_URL`, `WEBHOOK_SECRET` |
| executor | `DB_SECRET_ARN`, `S3_RAW_BUCKET`, `S3_PROCESSED_BUCKET`, `SNS_DRIFT_TOPIC_ARN` (optional), `EXECUTOR_MAX_ATTEMPTS` (optional, default 3), `SENTRY_DSN` (optional), `AWS_REGION` |
| drift | `DB_SECRET_ARN`, `AWS_REGION` |

Python dependencies are pinned in `lambdas/*/requirements.txt`. At runtime pandas/numpy come from the AWS SDK for pandas (`AWSSDKPandas-Python312`) layer. The code is tested on pandas 2.2.3 and 3.0.6 because the deployed layer version is not recorded here.

---

## Deployment

**Web app.** Vercel builds `main` (`npm run build`). The build needs no secrets because configuration is validated per request. Set the variables above in the Vercel project.

**Migrations.** Run `run-migration.mjs` (see above) **before** deploying code that needs new tables. Migration `002_ai_usage_tables.sql` creates `bedrock_usage` and `ai_spend_limits`. Without them, AI metering and the spend cap do not work.

**Lambdas.** Each Lambda is deployed as its handler plus its `requirements.txt`. The profiler and executor also attach the AWSSDKPandas layer. There is no build or deploy script in the repo yet, so build the zip from the pinned requirements (excluding pandas/numpy, which the layer provides) and update the function:

```bash
aws lambda update-function-code --function-name cleanstack-executor \
  --zip-file fileb://executor.zip --region us-east-1
```

**AWS settings the code relies on** (configure them in AWS; they cannot be checked from this repo):

- **Executor SQS queue:** visibility timeout ≥ the executor Lambda timeout (AWS recommends 6×), and a dead-letter queue with `maxReceiveCount` ≥ `EXECUTOR_MAX_ATTEMPTS`. The handler does not return partial batch failures, so one failing record retries the whole batch. That is safe because execution is idempotent, but `BatchSize: 1` keeps retries simple.
- **Processed bucket CORS:** allow `GET` from the app origin. The browser fetches the presigned URL for **Export As**; the plain download is a navigation and needs no CORS.
- **IAM for the web app role:** `s3:PutObject` (raw), `s3:GetObject` (processed), and for account erasure `s3:ListBucketVersions`, `s3:ListBucket`, `s3:DeleteObject` and `s3:DeleteObjectVersion` on both buckets, plus `sqs:SendMessage` on both queues, `rds-data:ExecuteStatement`/`BeginTransaction`/`CommitTransaction`/`RollbackTransaction` on the cluster, `secretsmanager:GetSecretValue` on the DB secret, and `bedrock:InvokeModel` for the configured model.
- **IAM for the executor:** the same S3 version permissions on the raw bucket. Without `s3:ListBucketVersions` it falls back to deleting only the two known raw keys.
- **Reconciler schedule:** something must call `GET /api/cron/reconcile-runs` with `Authorization: Bearer $CRON_SECRET` every few minutes. `vercel.json` defines no cron. The project's earlier documentation describes an EventBridge rule running every 5 minutes.

---

## Operations runbook

**Logs.** Server routes write one JSON object per line (`src/lib/logger.ts`): `{"ts","level","msg","service","route",...}`. Filter by `run_id`, `route` or `level`. Credential-like keys are redacted. Lambdas log plain text to CloudWatch.

| Symptom | What to check / do |
|---|---|
| Run stuck in `profiling`/`awaiting_ai`/`queued`/`running` | `reconcile-runs` marks these `failed` after 20 minutes, so confirm the scheduler is calling it. For `queued`: if the log has `SQS send failed; run left queued without a message`, re-send the message: `aws sqs send-message --queue-url "$SQS_QUEUE_URL" --message-body '{"run_id":"<id>"}'`. This is safe because execution is idempotent. |
| Run `failed` with `Attempt n/3 failed, retrying` history | Transient errors are retried by SQS up to `EXECUTOR_MAX_ATTEMPTS`; the last attempt marks the run failed. Check executor CloudWatch logs for the run id. |
| Approved rule shows **Not applied** | Expected when a rule is unsafe or invalid (the reason is shown). The rest of the run is unaffected. |
| User reports the file is missing `__orig_*` original values | By design. They are in `processed/{pipeline}/{run}/audit.csv`. |
| **Export As** fails but download works | CORS on the processed bucket (see Deployment). |
| `DELETE /api/account` returns 500 "No account data was removed" | S3 purge failed. Search logs for `S3 purge incomplete` / `S3 purge failed`, fix the IAM permissions, and have the user retry. The database is left intact so the retry is complete. `all_versions_purged: false` in a 200 response means `s3:ListBucketVersions` is missing. |
| Startup log `invalid or missing environment` | Set the listed variables in Vercel and redeploy. |
| Rotating `WEBHOOK_SECRET` | Update the Vercel env **and** the profiler and ai-trigger Lambdas together. Requests fail with 401 while they differ. |
| AI spend | `GET /api/admin/ai-spend` with `x-admin-secret` lists the current month's estimated spend per team. |

---

## Security model

What the code does today. Settings that live only in AWS are listed as such.

- **Authentication.** Clerk. `src/middleware.ts` protects the app pages and user API routes, and each route also calls `auth()` and returns 401 without a user.
- **Tenant isolation is enforced in application code**, not by the database. Every user query filters on `pipelines.team_id = <Clerk user id>`. `queryWithTeam()` sets `app.team_id` for the transaction, but **no Row-Level Security policies are defined** in `schema.sql`, so that setting currently has no effect. A missing `team_id` predicate in a new query would leak data across tenants.
- **Service-to-service calls** (Lambdas → webhooks, cron, admin) use shared secrets compared with `safeCompare` (`src/lib/secrets.ts`: SHA-256 then `timingSafeEqual`). It fails closed when the expected secret is not configured.
- **File access.** Uploads go straight to S3 with a 300 s presigned PUT; downloads use a 120 s presigned GET for the caller's own completed run. Files never pass through the serverless function.
- **Data lifecycle.**
  - After a successful execution, the executor deletes every object version under the run's raw prefix (`{user}/{pipeline}/{run}/`), including `extracted_text.txt` (`auto_delete_raw`, on by default).
  - Raw files of **failed** runs are not deleted, and there are no S3 lifecycle rules in the repo.
  - `DELETE /api/account?confirm=true` purges every version and delete marker under the user's raw prefix and their pipelines' processed prefixes, then deletes the DB rows. If S3 fails it aborts before touching the DB.
- **AI.** Uploaded content is sent to Amazon Bedrock and wrapped in `<user_data>` tags with an instruction to treat it as data. This reduces prompt-injection risk but does not prevent it, which is why rules need approval (or the committee in auto mode). The monthly AI spend cap is checked in `suggest-transforms` only.
- **Abuse limits.** Upstash sliding-window limits per user: 20 uploads/h, 50 AI calls/h, 30 chat messages/h. They fail open when Redis is not configured.
- **Headers.** A CSP is set in `next.config.ts`. It allows `'unsafe-inline'` and `'unsafe-eval'` for scripts (needed by Next.js and Clerk without nonces).
- **Secrets.** Nothing secret is committed. `.env.example` has placeholders only, and `run-migration.mjs` reads the database host from the environment. AWS account ids and ARNs from older commits remain in git history.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

---

## Known limitations

- **No RLS.** Isolation depends on every query including the `team_id` predicate (see above).
- **No infrastructure as code.** Buckets, queues, IAM, KMS, Lambda timeouts, DLQs, CORS and the cron schedule are configured by hand and cannot be reviewed or reproduced from the repo.
- **No automatic re-enqueue.** If the SQS send after approval fails, the run stays `queued` until the reconciler marks it failed (see the runbook).
- **No retention enforcement.** Raw files of failed runs stay in S3; `data_retention_days` is not enforced.
- **Downloads are served as stored.** Deliverables produced before the sidecar split may still contain `__orig_*` columns. **Export As** and the training export strip them; the native download does not. Re-run those pipelines to regenerate them.
- **Excel blanks are not counted as nulls** by the profiler (cells are read as empty strings). Before/after scores are still computed the same way.
- **AI spend cap coverage.** The cap is checked before `suggest-transforms` only. Committee calls are metered but not blocked, and chat-builder calls are neither metered nor blocked.
- **No upload size limit**, and `semantic_deduplicate` is O(n²). Large files can exhaust the executor Lambda.
- **Schema drift alerts** store their diff inside `column_definitions`, so the next alert reports a phantom `_diff` column.
- **Templates** copy approved rules from all recent runs of a pipeline, not only the latest run.
- **`middleware.ts`** uses the file convention that Next.js 16 deprecated in favour of `proxy.ts`. It still works; the rename is pending a test against real Clerk keys.
- **Parquet** is neither accepted for upload nor produced as output.
- **Dev-only advisories.** `npm audit` reports 4 moderate advisories in drizzle-kit's bundled esbuild (dev dependency only).
- **CI is defined but not enabled** until the workflow file is moved into `.github/workflows/`.

---

## Transform rules

The model can only suggest rules the executor implements (a contract test compares the two lists). Risk tiers decide how many committee votes a rule needs in auto mode: LOW 1/3, MEDIUM 2/3, HIGH 3/3.

### Tabular

| Rule | What it does |
|---|---|
| `trim_whitespace` | Strip leading/trailing whitespace in text columns |
| `deduplicate` | Drop exact duplicate rows (row-loss guard 20%) |
| `semantic_deduplicate` | Drop near-duplicate rows (MinHash) |
| `fill_nulls` | Fill nulls (mean / median / mode / constant); original kept in the audit file |
| `drop_nulls` | With a column: drop rows where that column is null. Without: drop rows with at least `ceil(threshold × columns)` nulls |
| `type_cast` | Cast to float / int / datetime / str. Not applied if values would be lost (e.g. `2.5` → int) |
| `normalize` | Text/date columns only: dates → `YYYY-MM-DD`, other text trimmed and lower-cased (or mapped via `value_map`); nulls stay null. Numeric columns are left unchanged |
| `filter`, `filter_extended` | Remove rows by condition (row-loss guard 20%) |
| `rename`, `column_header_normalize` | Rename columns / snake_case headers |
| `ner_redact` | Regex-based redaction (name, organisation, address/ZIP, date patterns). Heuristic, not a trained NER model |
| `ffill`, `bfill` | Fill nulls from the previous/next row (signal-gated) |
| `bool_cast` | Normalise yes/no/true/false/1/0 variants |
| `outlier_cap` | Cap values at the IQR fences |
| `multi_currency_strip` | Strip currency symbols and convert to numbers |
| `split_column` | Split a column on a delimiter into new columns |

### Documents (PDF, DOCX, TXT)

`strip_pii`, `ner_redact`, `fix_encoding`, `remove_headers_footers`, `remove_blank_lines`, `normalize_whitespace`, `strip_html`, `redact_pattern` (pattern length capped at 200 characters; no protection against catastrophic backtracking).

Accepted uploads: CSV, TSV, TXT, JSON, JSONL, XLSX, XLS (delivered as XLSX), XML, PDF, DOCX.

---

## Project layout

```
src/app/            pages and API routes (api/*/route.ts)
src/components/     React components
src/lib/            db (Data API), env, logger, secrets, ai-config, s3-erase,
                    download/training-export helpers, schema.sql, migrations/
lambdas/            profiler, executor, ai-trigger, drift handlers + tests/
ci/                 verify.sh and the (not yet enabled) GitHub Actions workflow
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and [SECURITY.md](SECURITY.md) for reporting issues.

## License

The project was published as MIT, but no `LICENSE` file has been committed yet.
