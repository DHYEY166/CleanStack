# Security model

This page describes what the code enforces today. Settings that live only in AWS are covered in [deployment.md](deployment.md).

- **Authentication.** Clerk handles sign-in. `src/middleware.ts` protects the app pages and the user API routes, and each route also calls `auth()` (`src/lib/auth.ts`) and returns 401 when there is no user.
- **Tenant isolation is enforced in application code, not by the database.** Every user query filters on `pipelines.team_id = <user id>`. `queryWithTeam()` sets `app.team_id`, but `schema.sql` defines **no Row-Level Security policies**, so that setting has no effect. A new query that leaves out the `team_id` predicate would leak data across tenants.
- **Service-to-service calls.** Lambda webhooks, crons and admin routes use shared secrets, compared with `safeCompare` (`src/lib/secrets.ts`: SHA-256, then `timingSafeEqual`). The check fails closed when the expected secret is not configured.
- **File access.** The browser uploads straight to S3 with a 300 s presigned POST. Its policy pins the key and the content type and caps the size with `content-length-range` (`src/lib/upload-limits.ts`: 100 MB or `MAX_UPLOAD_MB`, 2 MB for guests). `/api/upload` rejects a larger declared size with 413. The profiler marks a run failed, without reading the object, if the stored object is over the limit. Downloads use a 120 s presigned GET, only for the caller's own completed run. Files never pass through the serverless functions.
- **Data lifecycle.**
  - After a successful execution, the executor deletes every object version under the run's raw prefix. This is the `auto_delete_raw` setting, which is on by default. Raw files of failed runs are kept.
  - `DELETE /api/account?confirm=true` and the guest purge both use `eraseTeam()` (`src/lib/erase-team.ts`). It removes every version and delete marker under the team's S3 prefixes, then deletes the database rows. If the S3 step fails, it stops before touching the database. The guest purge keeps `bedrock_usage` rows so that the shared AI cap and cost reporting stay correct.
- **AI.** Uploaded content is sent to Amazon Bedrock inside `<user_data>` tags, with an instruction to treat it as data. This reduces prompt-injection risk but does not prevent it, which is why rules need approval or a committee vote. `checkAiBudget` (`src/lib/bedrock-meter.ts`) runs in Postgres before every Bedrock call: suggest-transforms, the auto-clean committee, the chat builder and synthetic data. Every call is metered in `bedrock_usage`. Costs are estimates based on the prices in `src/lib/ai-config.ts`.
- **Rate limits.** Upstash sliding windows per user: 20 uploads/h, 50 AI calls/h and 30 chat messages/h. They fail open when Redis is not configured. The guest limits below are enforced in Postgres and do not depend on Upstash.
- **Headers.** `next.config.ts` sets a CSP (`src/lib/csp.ts`). For scripts it allows `'unsafe-inline'` and `'unsafe-eval'`, which Next.js and Clerk need without nonces. It adds the Cloudflare Turnstile origins when Turnstile is configured.
- **Secrets.** Nothing secret is committed, and `.env.example` contains only placeholders. AWS account ids and ARNs from older commits remain in git history.

## Guest access

Guest access is off until `GUEST_COOKIE_SECRET` is set. `POST /api/guest` checks Turnstile when `TURNSTILE_SECRET_KEY` is set. It then issues an httpOnly, `SameSite=Lax`, `Secure` cookie `cs_guest` = `guest_<22 chars>.<expiry>.<HMAC-SHA256>`, which is valid for 24 h. `auth()` returns the `guest_…` id only when no Clerk user is signed in. That id is the guest's `team_id`, so tenant isolation applies unchanged. Sessions are recorded in `guest_sessions` with an HMAC of the client IP; the raw IP is never stored.

| Limit | Value | Enforced in |
|---|---|---|
| File size | 2 MB | presigned POST policy, `/api/upload` (413), profiler |
| Rows per run | 5,000 | `suggest-transforms`, before templates or AI (the run fails) |
| Rows per guest | 10,000 across all passes | `checkQuota` (guest plan) |
| Uploads | 3 per guest, 10 per IP hash per 24 h | capped `INSERT` in `src/lib/guest-quota.ts`, which also refuses expired sessions |
| Pipelines | 5 per guest | `POST /api/pipelines` |
| AI calls | 10 per rolling hour | `checkAiBudget` |
| AI spend | $0.25 per guest, and $5 per UTC day for all guests together | `checkAiBudget` |
| Sessions | 5 per IP hash, and 200 overall, per 24 h | `POST /api/guest` |

The values live in `src/lib/guest-limits.ts`. Guests cannot use the chat builder or synthetic data, auto-clean, training export, Slack alerts, account deletion, templates or `/api/admin`. The middleware answers 403 for these, or redirects `/templates` to the dashboard, and each route also rejects guest ids (`forbidGuest`). **Try with sample data** (`POST /api/sample-data`) uploads the CSV from `src/lib/sample-data.ts` and attaches the demo template that migration 003 seeds, so it makes no Bedrock call. After 24 h the cookie stops working, and `/api/cron/purge-guests` erases the guest's data. Guest work is not carried over to a new account on sign-up.

Report vulnerabilities as described in [SECURITY.md](../SECURITY.md).
