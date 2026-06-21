# CleanStack

**AI-powered data pipeline automation for B2B teams.**

CleanStack turns raw, messy data into clean, analytics-ready datasets through a multi-pass AI pipeline with a human-in-the-loop approval workflow — the "Data PR." Upload a CSV, Excel, JSON, PDF, DOCX, XML, or Parquet file. CleanStack profiles it, proposes a precise set of transform rules, routes them through a 3-agent AI committee, executes them on AWS Lambda, and delivers a quality-scored output. All in under two minutes.

**Live:** [clean-stack-eta.vercel.app](https://clean-stack-eta.vercel.app)

---

## The Problem

Data teams spend 60–80% of their time cleaning data before analysis. Existing tools (Fivetran, Airbyte, Talend) cost $500+/month, require weeks of setup, and still need engineers to write transform logic. Smaller teams are left scripting pandas in Jupyter notebooks with no audit trail, no version control, and no quality measurement.

CleanStack solves this with an AI-driven pipeline that costs ~$5/month to run at SME scale.

---

## Key Features

### Data PR Workflow
Every cleaning operation goes through a GitHub-style pull request before it executes. AI suggests rules with reasoning citing actual data evidence; a human approves or rejects each one. Full audit trail stored in Aurora PostgreSQL.

### Multi-Pass Auto-Clean
After pass 1, click **⚡ Auto-Clean Remaining** to trigger up to 2 additional AI passes automatically. Each pass re-profiles the output, generates conservative rules (no row-dropping), routes them through the AI committee, and executes — stopping when quality gains are diminishing returns.

### AI Committee (3-Agent Review)
Three specialized Claude agents review each rule in parallel in auto-clean mode:
- **SafetyAuditor** — checks for data loss risk
- **Statistician** — validates statistical soundness  
- **DomainValidator** — evaluates domain appropriateness

Risk thresholds: LOW rules (trim, fill) need 1/3 votes, MEDIUM (type_cast, deduplicate) need 2/3, HIGH rules (drop_nulls, filter) need unanimous approval.

### Multi-Format Support
CSV, TSV, Excel (xlsx/xls), JSON, JSONL, XML, Parquet, PDF, DOCX. Tabular files get column-level profiling; documents get PII detection, NER redaction, header/footer removal, and encoding repair.

### Data Quality Score
Every run shows a 0–100 quality score before and after, with breakdown of null %, duplicate %, type mismatches, outliers, and sentinel values. Score improvements tracked across passes.

### AI Training Export
Export cleaned datasets as Raw JSONL, Alpaca, or Chat (OpenAI) format for LLM fine-tuning, with configurable train/val/test splits.

### Schema Drift Alerts
After each execution, CleanStack hashes the output schema and compares to the previous run. If structure changes, an SNS alert fires to email and Slack.

### Chat Builder
Describe your data problem in plain English. CleanStack's AI suggests a pipeline configuration and previews the rules before you upload anything.

### Template Marketplace
Save and reuse cleaning configurations as templates. Templates skip the AI step entirely — instant execution.

---

## Architecture

```
User Upload (Browser)
         │
         │  POST /api/upload → presigned S3 URL
         ▼
S3 Raw Bucket (SSE-KMS encrypted, versioning enabled)
         │
         │  S3 PUT event
         ▼
AWS Lambda — Profiler (Python 3.12)
  • Parses 9 file formats (CSV, Excel, JSON, XML, Parquet, PDF, DOCX...)
  • Column-level stats: null %, duplicates, type mismatches, outliers, sentinel values
  • Quality score 0–100
  • Writes data_profiles to Aurora PostgreSQL
  • POSTs to /api/webhooks/profile-complete
         │
         │  Webhook → SQS enqueue (async, profiler returns immediately)
         ▼
AWS SQS — cleanstack-ai-jobs queue
         │
         │  SQS trigger (within seconds)
         ▼
AWS Lambda — AI Trigger (Python 3.12)
  • Dequeues run_id
  • HTTP POSTs to /api/suggest-transforms
         │
         ▼
Next.js API — /api/suggest-transforms
  • Claude Sonnet 4.6 via AWS Bedrock (structured output, Zod schema)
  • Generates 6–20 transform rules with AI reasoning
  • Pass 2+: conservative prompt (normalize/type_cast only, no row drops)
  • If auto-clean: calls /api/auto-validate for AI committee review
         │
         │  (manual mode) → status: awaiting_approval → user reviews Data PR
         │  (auto mode)  → /api/auto-validate → AI committee → SQS
         ▼
AWS SQS — cleanstack-jobs queue
         │
         │  SQS trigger
         ▼
AWS Lambda — Executor (Python 3.12)
  • Reads approved rules from Aurora
  • Applies transforms via pandas (16 rule types)
  • Row count safety guard: >10% loss in auto_mode → abort
  • Writes processed file to S3 Processed Bucket
  • Re-profiles output, updates Aurora with new quality score
  • Deletes raw file (auto_delete_raw=true, privacy by design)
  • If quality improvement ≥5% AND pass <3 → auto-creates next pass
         │
         │  (on schema drift)
         ▼
AWS Lambda — Drift Checker
  • Computes schema diff
  • Posts to Slack webhook
  • Stores snapshot in Aurora

Supporting infrastructure:
  • AWS EventBridge → fires reconciler cron every 5 min (marks stuck runs as failed)
  • Upstash Redis → caches billing quota (60s TTL, reduces DB calls)
  • Sentry → error monitoring on Next.js + Lambdas
  • AWS GuardDuty → threat detection
  • AWS CloudTrail → API audit trail
```

**Frontend:** Next.js 16 App Router on Vercel  
**Database:** Amazon Aurora PostgreSQL Serverless v2 via Data API (HTTP, no connection pooling issues)  
**AI:** Claude Sonnet 4.6 via Amazon Bedrock (`us.anthropic.claude-sonnet-4-6`)  
**Auth:** Clerk (with Row-Level Security in Aurora scoped to team_id)  
**Storage:** S3 (SSE-KMS encrypted, versioned, access-logged)  
**Compute:** AWS Lambda Python 3.12 + AWSSDKPandas layer  

---

## Security

| Layer | Implementation |
|-------|---------------|
| Authentication | Clerk (every authenticated route) |
| Tenant isolation | PostgreSQL Row-Level Security on 4 tables + `queryWithTeam()` helper |
| S3 access | SSE-KMS encryption, versioning, access logging, CORS restricted to production domain |
| Secret comparison | `crypto.timingSafeEqual` on all webhook/admin secret checks |
| Rate limiting | Upstash Redis sliding window — 20 uploads/hr, 50 AI calls/hr/team, 30 chat/hr |
| AI spend cap | Per-team monthly cap ($50 soft, $200 hard), tracked in `bedrock_usage` table |
| Prompt injection | User data wrapped in `<user_data>` tags with explicit AI instruction |
| Content Security Policy | Full CSP with frame-src/object-src none |
| GDPR erasure | `DELETE /api/account?confirm=true` — cascades all DB + S3 deletion |
| Input validation | File types allowlisted, content_type derived server-side, rule arrays capped at 100 |
| ReDoS protection | `redact_pattern` regex length-capped at 200 chars with `re.error` catch |
| Error responses | Generic messages to clients, full errors logged to Sentry only |
| MFA enforcement | AWS IAM policy requiring MFA for console operations |
| Threat detection | AWS GuardDuty + CloudTrail enabled |
| Dependency CVEs | xlsx replaced with `@e965/xlsx` (patched fork) |

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 16, Tailwind CSS, Recharts |
| AI | Claude Sonnet 4.6 (Bedrock), Vercel AI SDK |
| Backend | Next.js API Routes (serverless) |
| Database | Amazon Aurora PostgreSQL Serverless v2 (Data API) |
| Storage | Amazon S3 (SSE-KMS, versioned) |
| Compute | AWS Lambda Python 3.12 |
| Queue | Amazon SQS (2 queues: ai-jobs + executor-jobs) |
| Alerts | Amazon SNS → Email / Slack |
| Cache | Upstash Redis (quota caching, rate limiting) |
| Auth | Clerk |
| Monitoring | Sentry (Next.js + Lambda) |
| Scheduling | AWS EventBridge (reconciler cron) |
| Security | AWS GuardDuty, CloudTrail, IAM with scoped policies |
| Deployment | Vercel |

---

## Getting Started

### Prerequisites

- Node.js 20+
- AWS account with Aurora PostgreSQL Serverless v2, S3, Lambda, SQS, SNS configured
- Clerk account
- Amazon Bedrock access (Claude Sonnet 4.6)
- Upstash account (Redis, free tier)
- Sentry account (free tier)

### Environment Variables

Create `cleanstack/.env.local`:

```env
# Clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=

# Aurora Data API
AURORA_CLUSTER_ARN=arn:aws:rds:REGION:ACCOUNT:cluster:CLUSTER_NAME
AURORA_SECRET_ARN=arn:aws:secretsmanager:REGION:ACCOUNT:secret:SECRET_NAME
DATABASE_URL=  # Used by migration scripts only

# AWS
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
S3_RAW_BUCKET=
S3_PROCESSED_BUCKET=
SQS_QUEUE_URL=                 # cleanstack-jobs (executor queue)
AI_JOBS_QUEUE_URL=             # cleanstack-ai-jobs (AI trigger queue)
SNS_DRIFT_TOPIC_ARN=

# App
NEXT_PUBLIC_APP_URL=
WEBHOOK_SECRET=                # Random 32-byte hex string
ADMIN_SECRET=                  # Random 32-byte hex string
ADMIN_EMAILS=                  # Comma-separated admin email addresses
ADMIN_USER_IDS=                # Comma-separated Clerk user IDs for admin bypass
CRON_SECRET=                   # Random 32-byte hex string

# Feature flags
AI_QUEUE_ENABLED=true          # Set false to disable SQS async chain

# Monitoring
SENTRY_DSN=
NEXT_PUBLIC_SENTRY_DSN=

# Cache
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

### Run Locally

```bash
cd cleanstack
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Database Setup

```bash
# Run schema (Aurora via Data API or psql)
node src/lib/migrations/run-migration.mjs

# Seed templates
psql $DATABASE_URL -f src/lib/seed-templates.sql
```

### Lambda Deployment

⚠️ **Important:** Do NOT re-zip from scratch. The profiler and executor use `AWSSDKPandas-Python312` layer which combined with dependencies exceeds the 250MB Lambda limit. Always patch the existing deployed zip:

```bash
# Get current deployed zip
URL=$(aws lambda get-function --function-name cleanstack-profiler \
  --region us-east-1 --query 'Code.Location' --output text)
curl -s -o /tmp/existing.zip "$URL"

# Patch handler only
zip /tmp/existing.zip -j lambdas/profiler/handler.py

# Deploy
aws lambda update-function-code \
  --function-name cleanstack-profiler \
  --zip-file fileb:///tmp/existing.zip \
  --region us-east-1
```

**Required Lambda environment variables:**

| Function | Required env vars |
|----------|------------------|
| `cleanstack-profiler` | `DATABASE_URL`, `APP_URL`, `WEBHOOK_SECRET`, `S3_RAW_BUCKET`, `S3_PROCESSED_BUCKET`, `SQS_QUEUE_URL`, `SNS_DRIFT_TOPIC_ARN`, `SENTRY_DSN` |
| `cleanstack-executor` | `DB_SECRET_ARN`, `S3_RAW_BUCKET`, `S3_PROCESSED_BUCKET`, `SQS_QUEUE_URL`, `SNS_DRIFT_TOPIC_ARN`, `SENTRY_DSN` |
| `cleanstack-ai-trigger` | `APP_URL`, `WEBHOOK_SECRET`, `SENTRY_DSN` |

---

## How It Works

1. **Upload** — Drop a file on New Pipeline. S3 PUT triggers Profiler Lambda.
2. **Profile** — Column-level stats, quality score 0–100, PII detection (document mode).
3. **Queue** — Profile-complete webhook enqueues to SQS (async — no blocking).
4. **AI Suggest** — AI Trigger Lambda calls suggest-transforms. Claude generates 6–20 rules.
5. **Review (Data PR)** — Approve or reject rules. Full AI reasoning shown per rule.
6. **Execute** — Approved rules → SQS → Executor Lambda applies transforms via pandas.
7. **Score** — Before/after quality score. Download clean file or export for AI training.
8. **Auto-Clean** — Optionally trigger 1–2 more AI-committee-approved passes automatically.

---

## Supported Transform Rules

| Rule | Description |
|------|-------------|
| `trim_whitespace` | Strip leading/trailing whitespace from string columns |
| `deduplicate` | Remove exact duplicate rows |
| `semantic_deduplicate` | Remove near-duplicate rows using MinHash similarity |
| `fill_nulls` | Fill missing values (mean / median / mode / constant) |
| `drop_nulls` | Drop rows exceeding null threshold |
| `type_cast` | Convert column to float / int / datetime / str |
| `normalize` | Standardize date formats (→ YYYY-MM-DD) and lowercase strings |
| `filter` | Remove rows matching condition (gt / lt / eq / neq / notnull) |
| `rename` | Rename column to snake_case |
| `ner_redact` | Redact named entities (PERSON, ORG, GPE, DATE, IP) |
| `strip_pii` | Remove emails, phones, SSNs, credit card numbers |
| `fix_encoding` | Repair corrupted unicode characters |
| `remove_headers_footers` | Strip repeated page headers/footers from documents |
| `remove_blank_lines` | Remove excessive blank lines from documents |
| `normalize_whitespace` | Collapse irregular spacing in document text |
| `strip_html` | Remove HTML tags from text |
| `redact_pattern` | Redact custom regex pattern (length-capped, validated) |

---

## Pricing

| Plan | Price | Included rows/mo | Overage |
|------|-------|-----------------|---------|
| Free | $0 | 50,000 (hard cap) | — |
| Pro | $49/mo | 1,000,000 | $0.50/100K rows |
| Team | $199/mo | 10,000,000 | $0.30/100K rows |
| Enterprise | Custom | Unlimited | Custom |

---

## Project Structure

```
cleanstack/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── upload/                  # Presigned S3 URL generation
│   │   │   ├── webhooks/profile-complete/  # Lambda → SQS enqueue
│   │   │   ├── suggest-transforms/      # AI rule generation
│   │   │   ├── auto-validate/[runId]/   # AI committee (3 agents)
│   │   │   ├── approve-rules/           # Data PR approval
│   │   │   ├── run-status/[runId]/      # Polling endpoint
│   │   │   ├── runs/[runId]/            # iterate + auto-clean
│   │   │   ├── pipelines/               # CRUD
│   │   │   ├── templates/               # Template marketplace
│   │   │   ├── cron/reconcile-runs/     # Stuck run cleanup
│   │   │   ├── admin/                   # set-plan, ai-spend
│   │   │   ├── account/                 # GDPR erasure
│   │   │   └── usage/                   # Quota status
│   │   ├── dashboard/                   # Pipeline list + stats
│   │   ├── pipelines/                   # New pipeline, run page, Data PR
│   │   └── templates/                   # Template marketplace
│   ├── components/
│   │   ├── QualityGauge.tsx
│   │   ├── ColumnStatsTable.tsx
│   │   ├── QualityTrendChart.tsx
│   │   ├── RunStatusPoller.tsx          # Exponential backoff polling
│   │   ├── IterationBanner.tsx          # Multi-pass UI
│   │   ├── AutoCleanSummary.tsx         # Committee vote breakdown
│   │   └── TrainingExport.tsx           # JSONL/Alpaca/Chat export
│   └── lib/
│       ├── db.ts                        # Aurora Data API client (HTTP)
│       ├── billing.ts                   # Row-based metered billing
│       ├── bedrock-meter.ts             # AI cost tracking per team
│       ├── quota-cache.ts               # Upstash Redis quota cache
│       ├── rate-limit.ts                # Upstash sliding window limits
│       ├── schema.sql                   # 9 tables + indexes
│       └── types.ts                     # TypeScript types
├── lambdas/
│   ├── profiler/                        # S3 trigger → profile → webhook
│   ├── executor/                        # SQS trigger → transform → re-profile
│   ├── ai-trigger/                      # SQS trigger → call suggest-transforms
│   └── drift/                           # SNS trigger → schema diff → Slack
└── public/
    └── arch.svg                         # Architecture diagram
```

---

## Built For

H0 — Hack the Zero Stack Hackathon (June 2026)  
Track: B2B SaaS  
Required integrations: Vercel + Amazon Aurora PostgreSQL  
Vercel Team ID: `team_3pfhz8jPHgRWWRVVOxPanm9I`

---

## License

MIT
