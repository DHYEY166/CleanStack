# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through GitHub's
[private vulnerability reporting](https://github.com/DHYEY166/CleanStack/security/advisories/new)
(the repository's **Security** tab), including:

- what is affected (route, Lambda, file) and how to reproduce it,
- the impact you expect (data exposure, privilege, cost),
- any logs or proof of concept, **with real customer data removed**.

Please give the maintainer a reasonable amount of time to fix the issue before you disclose it
publicly.

## Supported versions

Only the `main` branch (what is deployed) receives fixes.

## Scope notes

The [security model](docs/security-model.md) describes what the code enforces today,
including known gaps. Reports in these areas are especially welcome:

- **Tenant isolation.** It relies on `team_id` predicates in application queries. There is no
  database Row-Level Security yet, so any query path that skips the predicate is a vulnerability.
- **Shared-secret routes** (`/api/webhooks/*`, `/api/suggest-transforms`, `/api/auto-validate/*`,
  `/api/cron/*`, `/api/admin/*`).
- **Presigned S3 URLs** and data deletion (`DELETE /api/account`, raw-file cleanup).
- **Prompt injection** through uploaded content that leads to harmful rules being suggested or
  auto-approved.

## Handling secrets

- Never commit real credentials. `.env*` files are git-ignored except `.env.example`, which holds
  placeholders only.
- Server logs go through `src/lib/logger.ts`, which redacts credential-like keys. Do not log
  request headers or uploaded content outside it.
- If a secret leaks, rotate it first (Clerk keys, `WEBHOOK_SECRET` in Vercel **and** the Lambdas,
  `CRON_SECRET`, `ADMIN_SECRET`, the AWS Secrets Manager DB secret) and then clean up history if
  needed.
