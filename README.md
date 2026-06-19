# CleanStack

**AI-powered data pipeline automation for B2B teams.**

CleanStack turns raw, messy data into clean, analytics-ready datasets through a multi-pass AI pipeline with a human-in-the-loop approval workflow. Upload a CSV, Excel, JSON, PDF, or DOCX file — CleanStack profiles it, proposes a precise set of transform rules, routes them through an AI committee for review, executes them on AWS Lambda, and delivers a quality-scored output. All in under two minutes.

Live: [clean-stack-eta.vercel.app](https://clean-stack-eta.vercel.app)

---

## The Problem

Data teams spend 60–80% of their time cleaning data before analysis. Existing tools (Fivetran, Airbyte, Talend) cost $500+/month, require weeks of setup, and still need engineers to write transform logic. Smaller teams are left scripting pandas in Jupyter notebooks with no audit trail.

CleanStack solves this with a fully automated, AI-driven pipeline that costs ~$5/month to run.

---

## Key Features

### Data PR Workflow
Every cleaning operation goes through a GitHub-style pull request before it executes. AI suggests rules with reasoning; a human (or AI committee in auto-clean mode) approves or rejects each one. Full audit trail stored in Aurora PostgreSQL.

### Multi-Pass Auto-Clean
After pass 1, click **Auto-Clean Remaining** to trigger up to 2 additional AI passes automatically. Each pass re-profiles the output, generates conservative rules (no row-dropping), routes them through the AI committee, and executes — stopping when quality gains are diminishing.

### AI Committee Review
Three specialized Claude agents review each rule in parallel:
- **SafetyAuditor** — checks for data loss risk
- **Statistician** — validates statistical soundness
- **DomainValidator** — evaluates domain appropriateness

Risk thresholds: LOW rules need 1/3 votes, MEDIUM need 2/3, HIGH rules (drop_nulls, filter) need unanimous approval.

### Chat Builder
Describe your data problem in plain English. CleanStack's AI suggests a pipeline configuration, previews the rules, and lets you generate a sample dirty dataset to test with — before you've uploaded anything.

### Multi-Format Support
CSV, TSV, Excel (xlsx/xls), JSON, JSONL, XML, Parquet, PDF, DOCX. Tabular files get column-level profiling; documents get PII detection, NER redaction, header/footer removal, and encoding repair.

### Data Quality Score
Every run shows a 0–100 quality score before and after cleaning, with a breakdown of null %, duplicate %, type mismatches, outliers, and sentinel values. Score improvements are tracked across passes.

### AI Training Export
Export cleaned datasets as Raw JSONL, Alpaca, or Chat (OpenAI) format for LLM fine-tuning, with configurable train/val/test splits.

### Schema Drift Alerts
After each execution, CleanStack hashes the output schema and compares it to the previous run. If structure changes, an SNS alert fires to email and Slack.

---

## Architecture

```
User Upload
    │
    ▼
S3 Raw Bucket (SSE-KMS)
    │
    ▼ S3 Event
AWS Lambda — Profiler (Python)
  • Parses 9 file formats
  • Computes column-level stats, null/dup/outlier/sentinel metrics
  • Quality score (0–100)
  • Writes to Aurora PostgreSQL
    │
    ▼ Webhook
Next.js API — /api/suggest-transforms
  • Claude Sonnet 4.6 via Bedrock (structured output, Zod schema)
  • Generates 6–12 transform rules with AI reasoning
  • Pass 2+: conservative prompt (normalize/type_cast only, no row drops)
    │
    ▼ (auto-clean mode)
/api/auto-validate/[runId]
  • 3 parallel Bedrock calls (AI committee)
  • Per-rule vote tally with risk-tier thresholds
  • Approve / reject with reasons
    │
    ▼ SQS
AWS Lambda — Executor (Python)
  • Applies approved transforms via pandas
  • Row count safety guard (>10% loss → abort)
  • Writes processed file to S3 Processed Bucket
  • Re-profiles output, updates Aurora
  • If improvement ≥5% AND pass <3: auto-creates next pass
    │
    ▼ SNS (on schema drift)
AWS Lambda — Drift Checker
  • Computes schema diff
  • Posts to Slack webhook
  • Stores snapshot in Aurora
```

**Frontend:** Next.js 16 App Router on Vercel  
**Database:** Amazon Aurora PostgreSQL (row-level isolation by team_id)  
**AI:** Claude Sonnet 4.6 via Amazon Bedrock (`us.anthropic.claude-sonnet-4-6`)  
**Auth:** Clerk  
**Storage:** S3 (raw + processed, SSE-KMS encrypted)  
**Compute:** AWS Lambda Python 3.12 + AWSSDKPandas layer  

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 16, Tailwind CSS, Recharts |
| AI | Claude Sonnet 4.6 (Bedrock), Vercel AI SDK |
| Backend | Next.js API Routes (serverless) |
| Database | Amazon Aurora PostgreSQL |
| Storage | Amazon S3 (SSE-KMS) |
| Compute | AWS Lambda (Python 3.12) |
| Queue | Amazon SQS |
| Alerts | Amazon SNS → Email / Slack |
| Auth | Clerk |
| Deployment | Vercel |

---

## Getting Started

### Prerequisites

- Node.js 20+
- AWS account with Aurora PostgreSQL, S3, Lambda, SQS, SNS configured
- Clerk account
- Amazon Bedrock access (Claude Sonnet 4.6)

### Environment Variables

Create `cleanstack/.env.local`:

```env
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
DATABASE_URL=
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
S3_RAW_BUCKET=
S3_PROCESSED_BUCKET=
WEBHOOK_SECRET=
NEXT_PUBLIC_APP_URL=
SQS_QUEUE_URL=
SNS_DRIFT_TOPIC_ARN=
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
psql $DATABASE_URL -f src/lib/schema.sql
psql $DATABASE_URL -f src/lib/seed-templates.sql
```

### Lambda Deployment

Each Lambda in `lambdas/` has its own `requirements.txt`. Package for `manylinux2014_x86_64 cp312` and deploy with the `AWSSDKPandas-Python312` layer attached.

```bash
# Profiler
cd lambdas/profiler
pip install -r requirements.txt -t package/
zip -r profiler.zip handler.py package/
aws lambda update-function-code --function-name cleanstack-profiler --zip-file fileb://profiler.zip

# Executor
cd lambdas/executor
pip install -r requirements.txt -t package/
zip -r executor.zip handler.py package/
aws lambda update-function-code --function-name cleanstack-executor --zip-file fileb://executor.zip
```

**Required Lambda environment variables:** `DATABASE_URL`, `APP_URL`, `WEBHOOK_SECRET`, `S3_RAW_BUCKET`, `S3_PROCESSED_BUCKET`, `SQS_QUEUE_URL`, `SNS_DRIFT_TOPIC_ARN`

---

## How It Works

1. **Upload** — Drop a file on New Pipeline. Profiler Lambda fires on the S3 event.
2. **Profile** — Column-level stats, quality score, PII detection (document mode).
3. **AI Suggest** — Claude generates 6–12 transform rules with reasoning, ordered by impact.
4. **Review (Data PR)** — Approve or reject rules individually. Full reasoning shown per rule.
5. **Execute** — Approved rules sent to SQS → Executor Lambda applies transforms.
6. **Score** — Before/after quality score. Download cleaned file or export for AI training.
7. **Auto-Clean** — Optionally trigger 1–2 more AI passes for incremental improvements.

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
| `filter` | Remove rows matching a condition (gt / lt / eq / neq / notnull) |
| `rename` | Rename column to snake_case |
| `ner_redact` | Redact named entities (PERSON, ORG, GPE, DATE, IP) |
| `strip_pii` | Remove emails, phones, SSNs, credit card numbers |
| `fix_encoding` | Repair corrupted unicode characters |
| `remove_headers_footers` | Strip repeated page headers/footers from documents |
| `remove_blank_lines` | Remove excessive blank lines from documents |
| `normalize_whitespace` | Collapse irregular spacing in document text |
| `strip_html` | Remove HTML tags from text |
| `redact_pattern` | Redact custom regex patterns |

---

## Pricing

| Plan | Price | Rows/month | Pipelines |
|------|-------|------------|-----------|
| Free | $0 | 10,000 | 3 |
| Pro | $49/mo | 1,000,000 | Unlimited |
| Enterprise | $299/mo | Unlimited | Unlimited + SSO + SLA |

---

## Project Structure

```
cleanstack/
├── src/
│   ├── app/
│   │   ├── api/               # API routes (upload, suggest-transforms, auto-validate, etc.)
│   │   ├── dashboard/         # Pipeline list
│   │   ├── pipelines/         # New pipeline, run pages, Data PR review
│   │   └── templates/         # Template marketplace
│   ├── components/            # UI components (QualityGauge, IterationBanner, AutoCleanSummary, etc.)
│   └── lib/
│       ├── db.ts              # Aurora connection pool
│       ├── schema.sql         # All 8 tables
│       ├── seed-templates.sql # Demo templates
│       └── types.ts           # TypeScript types
├── lambdas/
│   ├── profiler/              # S3 trigger → profile → webhook
│   ├── executor/              # SQS trigger → transform → re-profile
│   └── drift/                 # SNS trigger → schema diff → Slack
└── public/
    └── arch.svg               # Architecture diagram
```

---

## Built For

H0 — Hack the Zero Stack Hackathon (June 2026)  
Track: B2B SaaS  
Required integrations: Vercel, Amazon Aurora / DSQL / DynamoDB

---

## License

MIT
