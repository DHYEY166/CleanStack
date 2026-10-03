# Operations runbook

**Logs.** Server routes write one JSON object per line (`src/lib/logger.ts`) with `ts`, `level`, `msg`, `service` and `route`. Filter by `run_id`, `route` or `level`. Keys that look like credentials are redacted. The Lambdas log plain text to CloudWatch.

| Symptom | What to check or do |
|---|---|
| Run stuck in `profiling`, `awaiting_ai`, `queued` or `running` | `reconcile-runs` marks runs stuck for 20 minutes as `failed`. It runs every 4 hours (`cron(0 */4 * * ? *)`), so a stuck run can stay that way for up to about 4 h 20 min. First confirm that the EventBridge rule `cleanstack-reconciler-5min` is firing. |
| Run `failed` with "Could not queue this run …" | Sending to SQS failed (log `SQS send failed; marking run failed` or `AI jobs SQS send failed; marking run failed`), so the route failed the run and returned 503. Check the queue URL and the `sqs:SendMessage` permission of `cleanstack-vercel`. The user retries by uploading again. |
| Runs stay in `pending` after upload | The profiler trigger is missing `Post`. It must fire on all object create events. |
| Run `failed` with `Attempt n/3 failed, retrying` in its history | SQS retries transient errors up to `EXECUTOR_MAX_ATTEMPTS` times, and the last attempt marks the run failed. Look up the run id in the executor's CloudWatch logs. |
| Approved rule shows **Not applied** | This is expected when a rule is unsafe or invalid. The page shows the reason, and the rest of the run is unaffected. |
| User says original values are missing from the file | This is by design. Originals are in `processed/{pipeline}/{run}/audit.csv`. |
| **Export As** fails but download works | Check CORS on the processed bucket. |
| `DELETE /api/account` returns 500 "No account data was removed" | The S3 purge failed. Search the log for `S3 purge incomplete` or `S3 purge failed`, fix the IAM permissions and have the user retry. The database is untouched, so the retry erases everything. `all_versions_purged: false` in a 200 response means `s3:ListBucketVersions` is missing. |
| Startup log `invalid or missing environment` | Set the listed variables in Vercel and redeploy. |
| Rotating `WEBHOOK_SECRET` | Update Vercel and the profiler and ai-trigger Lambdas together. Requests fail with 401 while the values differ. |
| AI spend | `GET /api/admin/ai-spend` with `x-admin-secret` lists this month's estimated spend per team. |
| Guests see "Guest AI capacity is used up for today" | All guests together have reached $5 of estimated Bedrock spend since 00:00 UTC. The cap resets at midnight UTC (`GUEST_LIMITS.aiSpendAllGuestsPerDayUsd`). |
| Guest data not being deleted | Check the rule `cleanstack-purge-guests-hourly` (now every 4 hours, `cron(0 */4 * * ? *)`) and its `invoke-purge-guests` policy. Each call erases up to 20 expired guests, so about 120 a day. The `guest_` lifecycle rule removes S3 objects after 1 day even if the purge stops, but the database rows remain until the purge runs. |

## Aurora auto-pause

The cluster `database-1` (Aurora Serverless v2, PostgreSQL 17.7) has a minimum of 0 ACU and pauses after 300 s without connections. It used to never pause, because the reconciler called the database every 5 minutes, and that cost about $45 a month. Both EventBridge rules (`cleanstack-reconciler-5min` and `cleanstack-purge-guests-hourly`) now run on `cron(0 */4 * * ? *)`, every 4 hours, so the cluster is paused most of the time.

The first request after a pause starts the resume, which takes about 15 s, or 30 s or more after a pause longer than 24 h. Callers wait instead of failing:

- **Web app (RDS Data API):** while the cluster resumes, the Data API answers `DatabaseResumingException`. `src/lib/db-resume.ts` retries only that error, for `ExecuteStatement`, `BeginTransaction`, `CommitTransaction` and `RollbackTransaction`, with backoff of 1, 2, 4 and then 8 s, for up to 35 s. AWS documents the request as cancelled before it ran, so retrying writes is safe. Any other error, including statement timeouts, is never retried. The log line is `database is resuming from auto-pause; retrying Data API call` (warn, with `op`). The cron routes have `maxDuration` 60 (reconcile) and 120 (purge) to leave room for the wait.
- **Lambdas (psycopg2, IAM auth):** profiler, executor and drift connect directly. A connection to a paused cluster normally waits until it has resumed. A failed connect (`OperationalError`, except authentication failures) is retried for up to 35 s. The CloudWatch line is `[db] connect failed, database may be resuming from auto-pause`. ai-trigger does not connect to the database.

If a request still fails with `DatabaseResumingException` after a long pause, the resume took longer than the 35 s budget. The constants are `RESUME_RETRY_BUDGET_MS` in `src/lib/db-resume.ts` and `DB_CONNECT_RETRY_BUDGET_S` in each Lambda.
