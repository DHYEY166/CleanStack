# Operations runbook

**Logs.** Server routes write one JSON object per line (`src/lib/logger.ts`) with `ts`, `level`, `msg`, `service` and `route`. Filter by `run_id`, `route` or `level`. Keys that look like credentials are redacted. The Lambdas log plain text to CloudWatch.

| Symptom | What to check or do |
|---|---|
| Run stuck in `profiling`, `awaiting_ai`, `queued` or `running` | `reconcile-runs` marks these runs `failed` after 20 minutes, so first confirm that the EventBridge rule `cleanstack-reconciler-5min` is firing. |
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
| Guest data not being deleted | Check the rule `cleanstack-purge-guests-hourly` and its `invoke-purge-guests` policy. Each call erases up to 20 expired guests. The `guest_` lifecycle rule removes S3 objects after 1 day even if the purge stops, but the database rows remain until the purge runs. |
