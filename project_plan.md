# CleanStack — B2B Data Pipeline Automation
## H0: Hack the Zero Stack — Full Project Plan

---

## 1. Product Summary

**What it does:** Automates raw data → clean, usable data pipeline for B2B teams.
**Who it's for:** Data engineers, analysts, ops teams at SMEs/startups who can't afford enterprise ETL tools.
**Core loop:** Upload raw data (CSV, JSON, Excel, PDF, images, XML, Parquet) → AI profiles + suggests transforms → team reviews/approves ("Data PR") → Lambda executes → processed data lands in Aurora → quality score jumps.
**Demo story:** *"Raw HubSpot CSV → AI profiles → suggests 7 fixes → manager approves → Lambda runs → quality score 42→91 → data ready for BI tools. Or drop a scanned invoice image — Claude Vision extracts the table automatically."*

---

## 2. Unique Differentiators

| Feature | Why Unique |
|--------|------------|
| **Data Quality Score (before/after)** | Visual proof of value — no competitor shows this cheaply |
| **"Data PR" Approval Workflow** | Human-in-loop governance — compliance teams love audit trails |
| **Conversational Pipeline Builder** | Natural language → full pipeline config, no forms |
| **Multi-format Ingestion** | CSV, JSON, Excel, PDF, images (receipts/invoices via Claude Vision), XML, Parquet — no competitor handles all at this price |
| **Fully Serverless** | Under $5/month for SME workloads vs. $500+/month for Fivetran |
| **Schema Drift Alerts** | Detects format changes in new batches before corrupting data |
| **Pipeline Template Marketplace** | Export/import reusable pipeline templates — network effect |

---

## 3. Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15 (App Router) on Vercel |
| UI Generation | v0.app |
| AI | Claude API (Anthropic) via Vercel AI SDK |
| **Primary DB** | **Amazon Aurora PostgreSQL** (required by hackathon) |
| Raw Data Storage | Amazon S3 |
| Transform Execution | AWS Lambda |
| Job Queue | Amazon SQS |
| Drift Alerts | Amazon SNS → email/Slack webhook |
| Monitoring | Amazon CloudWatch |
| Secrets | AWS Secrets Manager |
| Auth | Clerk (Vercel Marketplace) |

---

## 4. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        VERCEL FRONTEND                          │
│  Dashboard │ Upload │ Chat Builder │ Data PR │ Marketplace      │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTPS
          ┌────────────────┼────────────────┐
          │                │                │
    Next.js API       Vercel AI SDK    Next.js API
    Routes            (Claude)         Routes
          │                │                │
          ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────────┐
│                         AWS SERVICES                            │
│                                                                 │
│  ┌──────────┐   trigger   ┌──────────────┐                      │
│  │  S3 Raw  │ ──────────► │  Lambda      │                      │
│  │  Bucket  │             │  Profiler    │                      │
│  └──────────┘             └──────┬───────┘                      │
│       ▲                          │ writes profile               │
│       │ upload                   ▼                              │
│  [User uploads              ┌──────────────────────────────┐   │
│   CSV/JSON]                 │   AURORA POSTGRESQL          │   │
│                             │                              │   │
│                             │  pipelines                   │   │
│                             │  pipeline_runs               │   │
│                             │  data_profiles               │   │
│                             │  transform_rules             │   │
│                             │  approval_reviews            │   │
│                             │  schema_snapshots            │   │
│                             │  pipeline_templates          │   │
│                             └──────────────┬───────────────┘   │
│                                            │                    │
│  [AI suggests transforms]                  │ approved rules     │
│  [User approves via Data PR]               ▼                    │
│                                    ┌───────────────┐           │
│                                    │  SQS Queue    │           │
│                                    │  (transform   │           │
│                                    │   jobs)       │           │
│                                    └───────┬───────┘           │
│                                            │ trigger            │
│                                            ▼                    │
│                                    ┌───────────────┐           │
│                                    │  Lambda       │           │
│                                    │  Transform    │           │
│                                    │  Executor     │           │
│                                    └───────┬───────┘           │
│                             ┌──────────────┴──────────────┐    │
│                             ▼                             ▼    │
│                      ┌──────────┐              ┌──────────┐    │
│                      │  S3      │              │  Aurora  │    │
│                      │Processed │              │(results  │    │
│                      │ Bucket   │              │metadata) │    │
│                      └──────────┘              └──────────┘    │
│                                                                 │
│  Schema Drift: SNS ──► email / Slack webhook                   │
│  Monitoring: CloudWatch Logs + Metrics                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. Aurora PostgreSQL Schema (Primary DB)

```sql
-- Pipeline definitions
CREATE TABLE pipelines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  owner_id TEXT NOT NULL,  -- Clerk user ID
  team_id TEXT NOT NULL,
  status TEXT DEFAULT 'active',  -- active | paused | archived
  template_id UUID REFERENCES pipeline_templates(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Each pipeline run (job)
CREATE TABLE pipeline_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id UUID REFERENCES pipelines(id),
  status TEXT DEFAULT 'pending',  -- pending | profiling | awaiting_approval | running | completed | failed
  raw_s3_key TEXT NOT NULL,
  processed_s3_key TEXT,
  row_count_raw INTEGER,
  row_count_processed INTEGER,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Data quality profile (before & after)
CREATE TABLE data_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES pipeline_runs(id),
  stage TEXT NOT NULL,  -- 'raw' | 'processed'
  quality_score INTEGER,  -- 0-100
  total_rows INTEGER,
  null_percentage NUMERIC(5,2),
  duplicate_percentage NUMERIC(5,2),
  type_mismatch_count INTEGER,
  outlier_count INTEGER,
  column_stats JSONB,  -- per-column breakdown
  created_at TIMESTAMPTZ DEFAULT now()
);

-- AI-suggested + user-approved transform rules
CREATE TABLE transform_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id UUID REFERENCES pipelines(id),
  run_id UUID REFERENCES pipeline_runs(id),
  rule_type TEXT NOT NULL,  -- drop_nulls | deduplicate | type_cast | rename | filter | join | custom
  column_name TEXT,
  parameters JSONB,  -- e.g. {"threshold": 0.8, "cast_to": "numeric"}
  ai_reasoning TEXT,  -- why AI suggested this
  status TEXT DEFAULT 'pending',  -- pending | approved | rejected
  order_index INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Approval workflow ("Data PR")
CREATE TABLE approval_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES pipeline_runs(id),
  reviewer_id TEXT NOT NULL,  -- Clerk user ID
  action TEXT NOT NULL,  -- approved | rejected | commented
  comment TEXT,
  rule_changes JSONB,  -- any modifications reviewer made
  reviewed_at TIMESTAMPTZ DEFAULT now()
);

-- Schema snapshots for drift detection
CREATE TABLE schema_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id UUID REFERENCES pipelines(id),
  run_id UUID REFERENCES pipeline_runs(id),
  schema_hash TEXT NOT NULL,
  column_definitions JSONB NOT NULL,  -- [{name, type, nullable}]
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Shareable pipeline templates
CREATE TABLE pipeline_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,  -- crm | marketing | finance | ecommerce | custom
  author_id TEXT NOT NULL,
  is_public BOOLEAN DEFAULT false,
  use_count INTEGER DEFAULT 0,
  transform_rules JSONB NOT NULL,  -- serialized rule definitions
  sample_input_schema JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## 6. AWS Lambda Functions

### Lambda 1: Data Profiler
**Trigger:** S3 PUT event on raw-data bucket
**Does:**
- Detects file format from extension + MIME type
- Parses by format:
  - CSV/TSV/TXT → pandas `read_csv` (auto-detect separator)
  - JSON/JSONL → pandas `read_json`
  - XLSX/XLS → `openpyxl` → DataFrame (multi-sheet: profile each sheet)
  - PDF → `pdfplumber` → extract largest table → DataFrame
  - JPG/PNG → Claude Vision API → extract structured fields → DataFrame
  - XML → `lxml` → flatten to DataFrame
  - Parquet → `pyarrow` → DataFrame
- Computes: null %, duplicate %, type mismatches, outlier count, column stats
- Calculates quality score (0–100)
- Writes profile to Aurora `data_profiles`
- Updates `pipeline_runs` status → `profiling_complete`
- Calls Vercel API webhook → triggers AI transform suggestion

**Runtime:** Python 3.13
**Memory:** 512MB | **Timeout:** 5 min

### Lambda 2: Transform Executor
**Trigger:** SQS message (after Data PR approved)
**Does:**
- Reads approved `transform_rules` from Aurora
- Reads raw file from S3
- Executes transforms in order (pandas/polars)
- Writes processed file to S3 processed bucket
- Computes post-transform quality profile
- Updates Aurora: run status → `completed`, writes processed profile
- Compares schema vs. last snapshot → if drift, fires SNS

**Runtime:** Python 3.13 (with pandas layer)
**Memory:** 1GB | **Timeout:** 15 min

### Lambda 3: Schema Drift Checker
**Trigger:** SNS from Transform Executor
**Does:**
- Compares current schema hash vs. stored snapshot
- If different: publishes SNS notification → email + Slack webhook
- Updates `schema_snapshots`

---

## 7. Frontend Pages (Next.js App Router)

```
/                          → Landing page
/dashboard                 → Pipeline list, recent runs, overall stats
/pipelines/new             → Create pipeline (chat or form)
/pipelines/[id]            → Pipeline detail, run history, quality trend
/pipelines/[id]/runs/[rid] → Run detail: Data PR view, quality scores, transforms
/templates                 → Marketplace: browse/import public templates
/templates/[id]            → Template detail, use count, sample schema
```

### Key UI Components
- **Quality Score Gauge** — animated 0–100 dial, before/after side-by-side
- **Data PR View** — list of AI-suggested transform rules, approve/reject/edit each, submit review
- **Pipeline Chat** — streaming chat interface, natural language → pipeline config
- **Schema Diff Viewer** — old vs. new column definitions highlighted
- **Column Stats Table** — null %, unique %, type, sample values per column

---

## 8. AI Integration (Claude via Vercel AI SDK)

### Prompt 1: Document Extractor (PDF/image inputs only)
Input: raw document (invoice, receipt, bank statement, scanned form) via Claude Vision
Output: JSON array of row objects with column names — feeds into Profiler as structured table

### Prompt 2: Transform Suggester
Input: raw data profile (column stats, quality issues) + sample rows
Output: ordered list of transform rules with reasoning

### Prompt 3: Conversational Pipeline Builder
Input: user's natural language description of pipeline
Output: structured pipeline config (sources, transforms, output schema)

### Prompt 4: Data Explainer
Input: column definitions + sample values
Output: plain-English explanation of what each column means, suggested relationships

All streamed via Vercel AI SDK `streamText`. Rules stored in Aurora `transform_rules`.

---

## 9. Data Flow — Step by Step

```
1. User uploads file via dashboard (CSV, JSON, JSONL, XLSX, XLS, PDF, JPG, PNG, XML, Parquet)
   → File → S3 raw bucket (key: {team_id}/{pipeline_id}/{run_id}/raw.{ext})
   → pipeline_runs row created (status: pending)

2. S3 PUT → triggers Lambda Profiler
   → Computes quality profile
   → Writes to data_profiles (stage: raw)
   → run status → awaiting_ai

3. Vercel API route calls Claude
   → Sends profile + sample rows
   → Streams back transform suggestions
   → Saves to transform_rules (status: pending)
   → run status → awaiting_approval

4. Team lead opens Data PR view
   → Reviews each rule (approve/reject/edit)
   → Submits review → approval_reviews row created
   → run status → queued

5. SQS receives transform job message
   → Lambda Executor picks up
   → Reads approved rules from Aurora
   → Reads raw.csv from S3
   → Applies transforms sequentially
   → Writes processed.csv to S3 processed bucket
   → Computes post-transform profile
   → run status → completed

6. Dashboard updates
   → Quality score before/after displayed
   → Download processed file
   → Schema snapshot saved
   → If drift vs. last run → SNS fires alert
```

---

## 10. 17-Day Build Plan

| Days | Milestone | Deliverable |
|------|-----------|-------------|
| 1–2 | Setup | Next.js scaffold on Vercel, Aurora provisioned, S3 buckets, Clerk auth, env vars wired |
| 3–4 | Upload + Profiler | File upload → S3, Lambda Profiler, quality score stored in Aurora, basic run view |
| 5–6 | AI Transforms | Claude integration via Vercel AI SDK, transform suggestions displayed |
| 7–8 | Data PR UI | Approve/reject/edit transform rules UI, approval_reviews stored |
| 9–10 | Transform Executor | SQS queue, Lambda Executor, transforms run, processed file in S3 |
| 11–12 | Quality Scores | Before/after score display, column stats table, quality trend chart |
| 13 | Schema Drift | Snapshot comparison, SNS → email alert |
| 14 | Template Marketplace | Export/import pipeline templates, public template list |
| 15 | Conversational Builder | Chat interface → pipeline config generation |
| 16 | Polish + Architecture Diagram | UI cleanup with v0.app, arch diagram, demo script |
| 17 | Submission | Record <3 min video, submit on Devpost |

---

## 11. Submission Checklist

- [ ] Vercel project deployed + Team ID noted
- [ ] Aurora PostgreSQL console screenshot
- [ ] Architecture diagram (use draw.io or Excalidraw)
- [ ] Demo video <3 min — show: upload → profile → Data PR → execute → quality score jump
- [ ] Text description mentioning Aurora PostgreSQL explicitly
- [ ] `#H0Hackathon` blog post or LinkedIn write-up (bonus points)

---

## 12. Judging Criteria Coverage

| Criterion | How We Hit It |
|-----------|--------------|
| **Technical Implementation** | Aurora + S3 + Lambda + SQS + SNS + CloudWatch — multi-service depth, clean DB schema, serverless architecture |
| **Design** | v0.app-generated UI, Data PR view mirrors GitHub PRs (familiar), quality score gauge is visual proof |
| **Impact** | Every B2B company has data prep pain. Serverless = $5/mo vs $500+ enterprise tools |
| **Originality** | "Data PR" governance + quality scoring combo not done by any existing tool at this price point |

---

## 13. Monetization Model

Target: B2B track judges evaluate "is this monetizable?" — need clear pricing.

### Pricing Tiers

| Plan | Price | Limits | Features |
|------|-------|--------|----------|
| **Free** | $0/mo | 3 pipelines, 10K rows/month | Upload, AI suggestions, basic quality score |
| **Pro** | $49/mo | Unlimited pipelines, 1M rows/month | Data PR workflow, schema drift alerts, template marketplace, webhook output |
| **Enterprise** | $299/mo | Unlimited everything | SSO, full audit logs, custom connectors, SLA, dedicated support |

### Why This Works
- Free tier: self-serve, no sales needed, builds top of funnel
- Pro $49/mo: affordable for any SME — one data analyst's hour saved pays for 6 months
- Enterprise: compliance-heavy industries (finance, healthcare) will pay for audit logs alone

### Add `/pricing` Page
- Show tier comparison table
- "Start Free" CTA → Clerk signup
- Stripe integration (or mock for demo) on Pro/Enterprise
- Takes ~2 hours to build, scores heavily on B2B monetizability criterion

---

## 14. Output Destinations

Current plan ends at: processed data → S3. Dead end for users. Add destination connectors:

| Destination | Implementation | Effort |
|-------------|---------------|--------|
| **Download CSV** | Pre-signed S3 URL | Already implied |
| **Webhook POST** | User provides URL, Lambda Executor POSTs processed JSON | 4 hours |
| **Copy to user's S3 bucket** | Cross-account via ARN + assumed IAM role | 1 day |

Add to Aurora schema:

```sql
-- Output destination config per pipeline
CREATE TABLE pipeline_destinations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id UUID REFERENCES pipelines(id),
  type TEXT NOT NULL,  -- download | webhook | s3
  config JSONB NOT NULL,
  -- webhook: {"url": "https://...", "headers": {...}}
  -- s3: {"bucket": "...", "prefix": "...", "role_arn": "..."}
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

Update data flow step 6: after `run status → completed`, Lambda Executor reads active destinations and dispatches accordingly.

**Priority:** Webhook output — 4 hours work, makes app actually production-usable, strong demo moment.

---

## 15. Data Security

B2B companies handle sensitive data. Judges from enterprise backgrounds will look for this. Critical for sales to compliance-heavy verticals (finance, healthcare).

### Implementation

| Layer | Measure |
|-------|---------|
| **S3 Raw Bucket** | SSE-KMS encryption, no public access, bucket policy locked to Lambda role only |
| **S3 Processed Bucket** | SSE-KMS encryption, pre-signed URLs expire in 1 hour |
| **Aurora** | Encryption at rest enabled, VPC-only access (no public endpoint) |
| **Data Isolation** | Row-level: every query WHERE team_id = $current_team — no cross-tenant data leaks |
| **Auto-Delete** | Raw files deleted from S3 after N days (configurable per pipeline) |
| **Secrets** | All credentials in AWS Secrets Manager, never in env vars or code |

Add to `pipelines` table:

```sql
ALTER TABLE pipelines ADD COLUMN data_retention_days INTEGER DEFAULT 30;
ALTER TABLE pipelines ADD COLUMN auto_delete_raw BOOLEAN DEFAULT true;
```

### Mention in Submission
Call out security explicitly in text description: *"All data encrypted at rest with SSE-KMS. Team-level row isolation. Raw files auto-deleted after configurable retention period."* Compliance teams are the buyers — this closes deals.

---

## 16. 3-Minute Demo Script

Write this now. Most teams lose points with disorganized demos.

```
[0:00–0:20] PROBLEM
"Your team gets 50 raw CSVs a week.
Someone spends 2 days cleaning them manually.
One mistake corrupts your entire analytics.
CleanStack fixes this in 2 minutes."

[0:20–0:50] UPLOAD + PROFILE
→ Drag HubSpot export CSV onto dashboard
→ Quality score animates: 42/100
→ Show column stats table:
  - revenue: 23% nulls
  - email: 847 duplicates, typed as string
  - signup_date: mixed formats (MM/DD/YYYY vs ISO)
"Our profiler found 3 critical issues automatically."
→ [BONUS 15s] Drop a scanned invoice image → Claude Vision extracts line items instantly
"Same pipeline works on images, PDFs, Excel — any format your team uses."

[0:50–1:30] AI SUGGESTIONS + DATA PR
→ AI streams 6 transform suggestions with reasoning
→ Open Data PR view — looks like GitHub PR
→ Approve 5, reject 1 (keep emails as-is, business reason)
→ Manager submits review
"Just like code review — but for data.
Full audit trail, stored in Aurora PostgreSQL."

[1:30–2:00] PIPELINE RUNS
→ Click "Run Pipeline"
→ Progress bar: profiling → transforming → complete
→ Quality score animates: 42 → 91
→ Row count: 12,400 raw → 11,553 after dedup
"91 out of 100. Clean, structured, ready."

[2:00–2:30] OUTPUT + AURORA
→ Download processed CSV
→ Show Aurora console — processed metadata queryable
→ Show webhook destination firing (Slack message appears)
"Data delivered wherever your team needs it."

[2:30–2:50] SCHEMA DRIFT ALERT
→ Upload next week's batch (column renamed: revenue → arr)
→ Alert fires → Slack notification appears instantly
"CleanStack caught a schema change before it broke your pipeline."

[2:50–3:00] CLOSE
→ Show /pricing page
"From $49/month. Free tier available today.
CleanStack — front-end in minutes, back-end designed for scale."
```

---

## 17. Suggested App Name Options

**Chosen name:** `CleanStack` — echoes hackathon theme "Zero Stack", memorable.
