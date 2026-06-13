# CleanStack — Detailed Implementation Plan

---

## PHASE 0: Environment Setup (Do First)

**Node upgrade:**
```bash
nvm install 20 && nvm use 20
node --version  # must show v20+
```

**Vercel:**
- vercel.com → New Project → import `DHYEY166/CleanStack` → deploy
- Note your **Vercel Team ID** (required for submission)

**AWS (do in parallel while Vercel deploys):**
- Aurora: RDS → Create → Aurora PostgreSQL → Serverless v2 → `cleanstack-db` → note endpoint
- S3: create 2 buckets — `cleanstack-raw-{your-account-id}` + `cleanstack-processed-{your-account-id}` → block all public access → enable SSE-KMS
- Secrets Manager: one secret `cleanstack/env` → store DB password

**Clerk:**
- clerk.com → Create app → "CleanStack" → copy `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY`

**.env.local** (create in `cleanstack/`):
```env
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...
DATABASE_URL=postgresql://...@your-aurora-endpoint:5432/cleanstack
AWS_REGION=us-east-1
S3_RAW_BUCKET=cleanstack-raw-...
S3_PROCESSED_BUCKET=cleanstack-processed-...
ANTHROPIC_API_KEY=sk-ant-...
```

---

## PHASE 1: Days 1–2 — Scaffold + DB + Auth

**Install packages:**
```bash
cd cleanstack
npm install @clerk/nextjs @aws-sdk/client-s3 @aws-sdk/s3-request-presigner pg drizzle-orm
npm install -D drizzle-kit
```

**Supported input formats (all handled by Lambda Profiler):**

| Format | Extensions | Real-world source | Parser |
|--------|-----------|------------------|--------|
| CSV / TSV / pipe-delimited | `.csv`, `.tsv`, `.txt` | HubSpot, Salesforce, DB exports | pandas auto-detect separator |
| JSON / JSONL | `.json`, `.jsonl` | API responses, Segment, event streams | pandas read_json |
| Excel | `.xlsx`, `.xls` | Finance reports, HR rosters, ops trackers | openpyxl |
| PDF | `.pdf` | Invoices, bank statements, purchase orders | pdfplumber → extract tables |
| Images | `.jpg`, `.jpeg`, `.png` | Receipts, scanned invoices, handwritten forms | Claude Vision API |
| XML | `.xml` | ERP exports, EDI, SOAP APIs | lxml |
| Parquet | `.parquet` | Data engineering, Spark outputs | pyarrow |

**Lambda Python dependencies to add:**
```
openpyxl>=3.1.0
pdfplumber>=0.10.0
pyarrow>=14.0.0
lxml>=4.9.0
```
Claude Vision handles images — no extra library needed, already in stack.

**Files to create:**

`src/lib/db.ts` — Postgres connection via `pg`

`src/lib/schema.sql` — run all 8 CREATE TABLE statements from project_plan.md section 5

`src/middleware.ts` — Clerk auth middleware protecting `/dashboard` and all `/pipelines/*`

`src/app/layout.tsx` — wrap with `<ClerkProvider>`

`src/app/(auth)/sign-in/page.tsx` + `sign-up/page.tsx` — Clerk components

`src/app/page.tsx` — landing page (hero, problem statement, CTA → sign up)

**Milestone check:** Deploy to Vercel, sign up works, Aurora reachable from API route.

---

## PHASE 2: Days 3–4 — Upload + Lambda Profiler

**Frontend:**

`src/app/dashboard/page.tsx` — pipeline list, "New Pipeline" button, stats

`src/app/pipelines/new/page.tsx` — file upload form (CSV, JSON, JSONL, XLSX, XLS, PDF, JPG, PNG, XML, Parquet — max 50MB)

`src/app/api/upload/route.ts` — generates S3 presigned PUT URL, creates `pipeline_runs` row in Aurora, returns URL + run_id to client

**Lambda Profiler** (`lambdas/profiler/handler.py`):
```python
# Triggered by S3 PUT on raw bucket
# 1. Detect file format from extension + MIME type
# 2. Parse by format:
#    - csv/tsv/txt  → pandas read_csv (auto-detect separator)
#    - json/jsonl   → pandas read_json
#    - xlsx/xls     → openpyxl → pandas DataFrame
#    - pdf          → pdfplumber → extract largest table → DataFrame
#    - jpg/png      → call Claude Vision API → extract structured fields → DataFrame
#    - xml          → lxml → flatten to DataFrame
#    - parquet      → pyarrow → pandas DataFrame
# 3. Multi-sheet Excel: extract all sheets, profile each separately
# 4. Compute: null%, duplicate%, type mismatches, outlier count, per-column stats
# 5. Quality score formula: 100 - (null_penalty + dupe_penalty + type_penalty)
# 6. Write to data_profiles (stage='raw')
# 7. Update pipeline_runs status → 'awaiting_ai'
# 8. POST to /api/webhooks/profile-complete with run_id
```

Deploy Lambda: Python 3.13, 512MB, 5min timeout, IAM role with S3+Aurora+SQS access

`src/app/api/webhooks/profile-complete/route.ts` — receives Lambda callback, triggers Claude

**Milestone check:** Upload CSV → S3 → Lambda fires → quality score in Aurora → dashboard shows run.

---

## PHASE 3: Days 5–6 — AI Transform Suggestions

**Install:**
```bash
npm install ai @anthropic-ai/sdk
```

`src/app/api/suggest-transforms/route.ts`:
```typescript
// POST with run_id
// 1. Fetch data_profile from Aurora
// 2. Fetch sample rows from S3
// 3. streamText with Claude — Transform Suggester prompt
// 4. Parse streamed JSON → save to transform_rules (status='pending')
// 5. Update pipeline_runs → 'awaiting_approval'
```

**Prompt 0 — Document Extractor (PDF/image inputs only, runs before profiling):**
```
You are a document data extraction expert. Extract all structured data from this document.
Output a JSON array of objects where each object is one row, keys are column names.
Preserve numeric values as numbers, dates as ISO strings.
Document type: {invoice | receipt | bank_statement | form | other}
```
Result feeds into Profiler as if it were a CSV.

**Prompt 1 — Transform Suggester:**
```
You are a data quality expert. Given this data profile and sample rows, suggest ordered transform rules.
Output JSON array: [{rule_type, column_name, parameters, ai_reasoning}]
Profile: {quality_score, null_percentage, column_stats}
Sample rows: [first 20 rows]
```

`src/app/pipelines/[id]/runs/[rid]/page.tsx` — run detail page, shows streaming suggestions

**Milestone check:** After upload + profile, AI streams 5–8 transform suggestions with reasoning.

---

## PHASE 4: Days 7–8 — Data PR Approval UI

`src/components/DataPR/RuleCard.tsx`:
- Shows rule type, column, AI reasoning
- Approve ✓ / Reject ✗ / Edit (inline params) buttons
- Green/red highlight on action

`src/components/DataPR/PRHeader.tsx`:
- "X rules suggested · Y approved · Z rejected"
- "Submit Review" button (disabled until all rules actioned)

`src/app/api/approve-rules/route.ts`:
- POST with `{run_id, rule_decisions: [{rule_id, action, modifications}]}`
- Updates `transform_rules` status per decision
- Creates `approval_reviews` row
- Sends SQS message to trigger executor
- Updates `pipeline_runs` → `'queued'`

**Milestone check:** Full Data PR flow works end-to-end, approval stored in Aurora with audit trail.

---

## PHASE 5: Days 9–10 — Transform Executor Lambda

**Lambda Executor** (`lambdas/executor/handler.py`):
```python
# Triggered by SQS message containing run_id
# 1. Fetch approved transform_rules from Aurora (ordered by order_index)
# 2. Read raw file from S3
# 3. Execute transforms sequentially using pandas:
#    - drop_nulls: df.dropna(subset=[col], thresh=threshold)
#    - deduplicate: df.drop_duplicates(subset=[col])
#    - type_cast: df[col].astype(target_type)
#    - rename: df.rename(columns={old: new})
#    - filter: df[df[col].apply(condition)]
# 4. Write processed.csv to S3 processed bucket
# 5. Compute post-transform quality profile
# 6. Write to data_profiles (stage='processed')
# 7. Update pipeline_runs → 'completed', set processed_s3_key
# 8. Compare schema vs last snapshot → if diff, publish SNS
# 9. Dispatch to pipeline_destinations
```

Deploy: Python 3.13 + pandas layer, 1GB, 15min timeout

`src/app/api/run-status/[runId]/route.ts` — polling endpoint for frontend progress bar

**Milestone check:** Approve Data PR → SQS → Lambda runs → processed CSV in S3 → run marked complete.

---

## PHASE 6: Days 11–12 — Quality Score Visualization

`src/components/QualityGauge.tsx`:
- Animated arc gauge 0–100
- Color: red (0–40), yellow (41–70), green (71–100)
- Before/after side-by-side with delta badge (+49 ↑)

`src/components/ColumnStatsTable.tsx`:
- Per-column: name, type, null%, unique count, sample values
- Highlight problem columns in red

`src/components/QualityTrendChart.tsx`:
- Line chart of quality score across last N runs (recharts)

Add all three to `/pipelines/[id]/runs/[rid]` page

**Milestone check:** Quality score animates 42→91 on run completion. Visually compelling for demo.

---

## PHASE 7: Day 13 — Schema Drift + SNS Alerts

**Lambda Drift Checker** (`lambdas/drift/handler.py`):
```python
# Triggered by SNS from Executor
# 1. Load current schema hash from event
# 2. Load last schema_snapshot for this pipeline from Aurora
# 3. If hash differs: compute column diff (added/removed/renamed/type changed)
# 4. Publish SNS notification → email + Slack webhook
# 5. Save new schema_snapshot
```

`src/components/SchemaDiffViewer.tsx` — old vs new columns, color-coded

`src/app/api/alerts/configure/route.ts` — save Slack webhook URL per pipeline

**Milestone check:** Upload file with renamed column → Slack message fires within 30s.

---

## PHASE 8: Day 14 — Template Marketplace

`src/app/templates/page.tsx` — grid of public templates, filter by category

`src/app/templates/[id]/page.tsx` — template detail, use count, "Use Template" button

`src/app/api/templates/route.ts` — GET (list public) + POST (create from existing pipeline)

`src/app/api/templates/[id]/use/route.ts` — clone template rules into new pipeline

Seed 3–4 demo templates: "HubSpot CRM Cleaner", "E-commerce Orders", "Finance Report Normalizer"

---

## PHASE 9: Day 15 — Conversational Pipeline Builder

`src/app/pipelines/new/page.tsx` — add chat tab alongside form tab

`src/app/api/chat-builder/route.ts`:
```typescript
// streamText with Pipeline Builder prompt
// Prompt: "Convert this description into a pipeline config JSON: {rules[], output_schema}"
// Stream response, parse final JSON, pre-fill pipeline form
```

`src/components/PipelineChat.tsx` — streaming chat UI, shows config preview as JSON builds

---

## PHASE 10: Day 16 — Polish + Submission Prep

- `/pricing` page — 3-tier table, "Start Free" CTA
- Architecture diagram — draw.io or Excalidraw, export PNG
- Vercel env vars — add all `.env.local` keys to Vercel dashboard
- Aurora console screenshot — save for submission
- Run full demo flow once end-to-end

---

## PHASE 11: Day 17 — Record + Submit

Record 3-min video following script in `project_plan.md` section 16.

Devpost submission checklist:
- [ ] Vercel project URL
- [ ] Vercel Team ID
- [ ] Aurora console screenshot
- [ ] Architecture diagram PNG
- [ ] Demo video (YouTube unlisted)
- [ ] Text description mentioning Aurora PostgreSQL explicitly
- [ ] LinkedIn post with `#H0Hackathon`

---

## Branch Strategy

```
main          ← stable, always deployable, Vercel auto-deploys
dev           ← integration branch
feature/setup
feature/upload-profiler
feature/ai-transforms
feature/data-pr
feature/executor
feature/quality-viz
feature/drift-alerts
feature/marketplace
feature/chat-builder
```

Merge feature → dev → test → merge dev → main after each phase.

---

## Priority Order

**Must have (Phases 0–6):** Setup + upload + profiler + AI transforms + Data PR + executor + quality viz — this is the full demo story.

**Nice to have:** Drift alerts (Day 13), marketplace (Day 14), chat builder (Day 15).

**Cut if time short:** Marketplace and chat builder. Core demo only needs Phases 0–6.
