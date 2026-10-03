# CleanStack

CleanStack cleans tabular files and documents with AI suggestions and human approval. A Lambda profiles each upload. Claude on Amazon Bedrock then proposes transform rules, each with a reason, and you approve or reject them in a "Data PR". A second Lambda applies the approved rules with pandas and returns the cleaned file with a before/after quality score.

**Live:** [clean-stack-eta.vercel.app](https://clean-stack-eta.vercel.app) · **Demo video:** [youtu.be/rhsA_740Zgs](https://youtu.be/rhsA_740Zgs)

[![Demo video](public/demo-thumb.png)](https://youtu.be/rhsA_740Zgs)

## Features

- **Upload and profile:** CSV, TSV, TXT, JSON, JSONL, XLSX, XLS (delivered as XLSX), XML, PDF and DOCX. Each file gets per-column statistics and a quality score.
- **AI-suggested rules, human-approved:** Claude proposes rules from a fixed set that the executor implements ([rule reference](docs/transform-rules.md)). You review them in a Data PR. Unsafe rules are skipped with a reason instead of half-applied.
- **Auto-clean:** a committee of three Claude reviewers votes on each rule. Higher-risk rules need more votes. Runs that are over the AI budget fall back to manual review.
- **Multi-pass:** up to 3 passes per run. Each pass is re-scored on the bytes that were actually written.
- **Outputs:** download in the original format, **Export As** another format, or export training JSONL (raw, Alpaca or chat). Original values go to a separate `audit.csv` and are never added to the deliverable.
- **Pipelines and templates:** save the approved rules of a pipeline as a template and reuse it. A chat builder can draft pipelines and synthetic data.
- **Schema drift alerts:** optional Slack webhook per pipeline.
- **Usage controls:** monthly row quotas per plan (Free: 50,000 rows; plans are assigned by an admin, with no payment integration), Upstash rate limits, and an AI spend cap checked in Postgres before every Bedrock call.
- **Guest access:** **Try as guest** on the landing and sign-in pages starts a 24-hour session with no account. **Try with sample data** loads a seeded demo template, so it makes no Bedrock call. Guests get 2 MB files, 3 uploads, 5,000 rows per run and 10 AI calls per hour, with $0.25 of AI spend per guest. AI-heavy or irreversible features (chat builder, auto-clean, training export, Slack alerts, templates, account deletion) are blocked for guests. A guest's data is erased by the purge that runs every 4 hours, once the 24-hour session has ended. [Full limits](docs/security-model.md#guest-access)

## Architecture

```
Browser ── Next.js 16 on Vercel (Clerk auth, API routes) ── Aurora PostgreSQL (RDS Data API)
   │ presigned POST (size-capped)            presigned GET (downloads) ◄── S3 processed bucket
   ▼
S3 raw bucket ── S3 event ──► Lambda profiler ──► webhook ──► suggest-transforms (Bedrock Claude)
                                             (inline, or SQS AI jobs queue ► Lambda ai-trigger)
Data PR approval / auto-clean ──► SQS executor queue ──► Lambda executor ──► S3 processed bucket
                                                         └─ schema changed ► SNS ► Lambda drift ► Slack
```

| Part | Code | Runs on |
|---|---|---|
| Web app and API | `src/` (App Router) | Vercel |
| Profiler | `lambdas/profiler/handler.py` | Lambda, S3 trigger on the raw bucket |
| AI trigger | `lambdas/ai-trigger/handler.py` | Lambda, SQS AI jobs queue; calls `/api/suggest-transforms` |
| Executor | `lambdas/executor/handler.py` | Lambda, SQS executor queue |
| Drift | `lambdas/drift/handler.py` | Lambda, SNS |
| Schema | `src/lib/schema.sql`, `src/lib/migrations/00N_*.sql` | Aurora PostgreSQL |

Other services: Clerk (auth), Upstash Redis (rate limits and quota cache, which fail open when not configured) and Sentry (optional). AWS resources are configured by hand, and there is no infrastructure as code in this repo.

A run moves through `pending → profiling → awaiting_ai → awaiting_approval → queued → running → completed | failed`. Execution is idempotent per run: the executor claims a run with a conditional `UPDATE`, so a duplicate SQS delivery is skipped. A run stuck for 20 minutes is marked failed by `/api/cron/reconcile-runs`, which runs every 4 hours.

## Local development

Requirements: Node.js 20 or 22, Python 3.12 and Docker (for the test services). The app has no local mock stack. Running it against real data needs Aurora, S3, SQS, Bedrock and Clerk.

```bash
npm ci
cp .env.example .env.local     # fill in real values
npm run dev                    # http://localhost:3000
AURORA_HOST=<cluster endpoint> node src/lib/migrations/run-migration.mjs   # schema + migrations
```

`run-migration.mjs` applies `schema.sql` and then each migration in order. Every statement is idempotent. It uses RDS IAM auth, or `DATABASE_URL` for a plain Postgres.

## Tests

```bash
ci/verify.sh        # eslint, tsc, vitest unit tests, next build, Lambda pytest

docker compose -f tests/support/docker-compose.yml up -d --wait   # Postgres 16 + LocalStack (S3, SQS)
npm run services:setup
PYTHON=python npm run test:integration                            # route + Lambda handlers in-process
CLEANSTACK_INTEGRATION=1 python -m pytest -q lambdas/tests/integration
npm run e2e:build && PYTHON=python npm run test:e2e               # Playwright against a test-mode build
```

No test calls real AWS, Bedrock or Clerk. CI (`.github/workflows/ci.yml`) runs 6 checks on every PR and on every push to `main`: `web (node 20)`, `web (node 22)`, `lambdas (pandas 2.2.3)`, `lambdas (pandas 3.0.6)`, `integration (postgres + localstack)` and `e2e (playwright)`. `main` requires all six, and a branch must be up to date with `main` before it can merge. See [CONTRIBUTING.md](CONTRIBUTING.md) for what each suite covers and for the test-mode switches.

## Configuration

`src/lib/env.ts` is the full contract, and `.env.example` lists every variable (a test enforces this). At startup the server logs any variable that is missing or invalid.

| Variable | Notes |
|---|---|
| `AURORA_CLUSTER_ARN`, `AURORA_SECRET_ARN` | Required. RDS Data API |
| `S3_RAW_BUCKET`, `S3_PROCESSED_BUCKET` | Required |
| `SQS_QUEUE_URL` | Required. Executor queue |
| `AI_QUEUE_ENABLED`, `AI_JOBS_QUEUE_URL` | Optional. Queue AI jobs instead of calling suggest-transforms inline |
| `NEXT_PUBLIC_APP_URL`, `WEBHOOK_SECRET`, `CRON_SECRET` | Required. Secrets need at least 32 chars (`openssl rand -hex 32`) |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Required |
| `GUEST_COOKIE_SECRET` | Optional. Guest access is off while it is unset |
| `TURNSTILE_SECRET_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Optional. Cloudflare Turnstile on guest sign-up |
| `MAX_UPLOAD_MB` | Optional. Default 100 for signed-in users (guests are always 2 MB). Keep it equal on the profiler Lambda |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `ADMIN_SECRET`, `ADMIN_EMAILS`, `ADMIN_USER_IDS`, `AWS_REGION`, `LOG_LEVEL` | Optional |

The Bedrock model id and token prices live in `src/lib/ai-config.ts`. Lambda variables are listed in [docs/deployment.md](docs/deployment.md#lambda-environment).

## Deployment

Vercel builds and deploys `main`. The Lambdas, migrations and AWS resources are deployed by hand. [docs/deployment.md](docs/deployment.md) covers:

- applying migrations 001–003 (`run-migration.mjs`, or the RDS Data API from CloudShell);
- the CloudShell zip-swap deploy for `cleanstack-profiler`, `cleanstack-executor`, `cleanstack-ai-trigger` and `cleanstack-drift`;
- raw bucket CORS (PUT, GET, POST), the profiler trigger on all object create events, and processed bucket CORS;
- EventBridge rules `cleanstack-reconciler-5min` and `cleanstack-purge-guests-hourly`, both now `cron(0 */4 * * ? *)` (every 4 hours, so Aurora can auto-pause), which call the cron routes through API destinations as the `cleanstack-eventbridge-invoker` role;
- the S3 lifecycle rule on the `guest_` prefix;
- least-privilege IAM for the `cleanstack-vercel` user and for the Lambda roles.

Operations runbook: [docs/operations.md](docs/operations.md). Security model: [docs/security-model.md](docs/security-model.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Known limitations

- **No Row-Level Security.** Tenant isolation depends on every query filtering on `team_id`.
- **No infrastructure as code.** Buckets, queues, IAM, Lambda settings and schedules cannot be reviewed or reproduced from this repo.
- **No automatic re-enqueue.** If sending to the executor or AI jobs queue fails, the run is marked failed right away and the user has to upload the file again ([runbook](docs/operations.md)).
- **Retention:** raw files of failed runs stay in S3, and `data_retention_days` is not enforced. The `guest_` lifecycle rule is the only exception.
- **The AI budget is checked before a call and recorded after it.** Concurrent requests can overshoot a cap by the cost of the calls in flight. Costs are estimates, not the AWS bill.
- **Upload limits are per file.** A file under the limit can still exhaust the executor's memory or time on expensive rules. Only `semantic_deduplicate` has a time and row guard.
- **Guest caps are per IP hash and per cookie.** Users behind one NAT share the caps, and guest work is not carried over on sign-up.
- **Older deliverables** may still contain `__orig_*` columns in the native download. Export As strips them.
- **Profiler:** Excel blanks are not counted as nulls, and Parquet is not supported.
- **Drift alerts** store their diff in `column_definitions`, so the next alert reports a phantom `_diff` column.
- **`src/middleware.ts`** uses the file convention that Next.js 16 deprecates in favor of `proxy.ts`.
- **Not covered by tests:** real Clerk sign-in, the RDS Data API, and the Lambdas' IAM-token database connection.

## License

[MIT](LICENSE) © 2026 Dhyey Desai
