# Contributing

## Workflow (GitHub Flow)

`main` is what Vercel deploys. Never push to it directly.

1. Branch from `main`: `feature/<short-name>` (or `fix/<short-name>` for a bug fix).
2. Make small, atomic commits. Each message says what changed and **why**, plus any alternative you
   rejected when it is not obvious. For a bug, commit a failing test first (`xfail(strict=True)` in
   pytest, or a failing vitest case), then the fix that turns it green.
3. Push early (`git push -u origin <branch>`) and open a pull request into `main`. Keep each PR to
   one concern. If two PRs touch the same files, stack the second on the first and say so in its
   description.
4. The PR description covers **What / Why / Look hardest at / Verified** (the commands you ran and
   their results) and lists any follow-ups you deliberately left out.
5. Merge only after review with all checks green.

## Local setup

```bash
npm ci
cp .env.example .env.local        # real values, never committed
python3.12 -m venv .venv && . .venv/bin/activate
pip install -r lambdas/requirements-dev.txt
```

## The gate (run before every push)

```bash
ci/verify.sh            # npm ci, eslint, tsc --noEmit, vitest, next build, pytest
```

or step by step:

```bash
npx eslint && npx tsc --noEmit && npx vitest run && npm run build
python -m pytest -q lambdas/tests
```

CI (`.github/workflows/ci.yml`) runs the same commands. It
also runs pytest against pandas 3.0.6, because the production pandas layer version is not pinned in
this repo. If your change touches the Lambdas, run that too:

```bash
pip install pandas==3.0.6 numpy==2.5.3 && python -m pytest -q lambdas/tests
```

### Integration and e2e suites

They need Docker (Postgres + LocalStack). CI runs them in the `integration` and `e2e` jobs on every PR.
Run them locally when you touch the database layer, S3/SQS code, the Lambdas, auth, or a user flow:

```bash
docker compose -f tests/support/docker-compose.yml up -d --wait
npm run services:setup
PYTHON=python npm run test:integration
CLEANSTACK_INTEGRATION=1 python -m pytest -q lambdas/tests/integration
npx playwright install --with-deps chromium     # once
npm run e2e:build && PYTHON=python npm run test:e2e
```

On a CI e2e failure, download the `playwright-report` artifact. It has the HTML report and the
traces; open a trace with `npx playwright show-trace test-results/<test>/trace.zip`.

Rules for test-only code (see README, "Test-only switches"):

- Gate it with `isTestMode()` from `src/lib/test-mode.ts`, nothing else, and add a test that it
  is off without `CLEANSTACK_TEST_MODE=1` and when `VERCEL=1`.
- Server code reads the user through `@/lib/auth`; eslint rejects `@clerk/nextjs/server`
  imports elsewhere, so the auth bypass keeps a single entry point.
- Every AI call is preceded by `checkAiBudget(teamId, calls)` and followed by an awaited
  `meterBedrockCall(...)` (`src/lib/bedrock-meter.ts`), so the guest and team caps see it.
- AI calls take their model from `languageModel()` (`src/lib/ai-model.ts`), never `bedrock()`
  directly, so CI never reaches Bedrock.
- Playwright's `webServer` inherits your shell's environment, and shell variables win over
  `tests/support/test-env.mjs`. Run e2e from a clean shell: an exported `CLEANSTACK_TEST_MODE`
  turns the guard servers (:3101, :3102) into test-mode servers and their tests fail.

## Conventions

- **Configuration:** read environment variables through `src/lib/env.ts` (`requireEnv`,
  `optionalEnv`, `awsRegion`). Add new variables to `ENV_SPEC` and `.env.example`; a test enforces
  the latter.
- **Guests:** a `guest_…` id (`src/lib/guest.ts`) is a normal `team_id`, so tenant queries need
  no change. Anything new that costs money (AI, storage, email) or is irreversible must check
  `isGuestId()` and apply the limits in `src/lib/guest-limits.ts`; add a test with a guest id.
- **Uploads:** the browser uploads with a presigned POST from `/api/upload`. Size limits live in
  `src/lib/upload-limits.ts` and are mirrored in `lambdas/profiler/handler.py`; change both
  together.
- **Logging (server):** use `logger.child({ route })` from `src/lib/logger.ts` and pass data as
  fields (`{ run_id, err }`). ESLint rejects `console.*` in `src/app/api` and `src/lib`.
- **Secrets:** compare shared secrets with `safeCompare` from `src/lib/secrets.ts`.
- **AI:** the Bedrock model id and prices live in `src/lib/ai-config.ts`. Do not hardcode them.
- **Database:** schema changes go in a new idempotent `src/lib/migrations/NNN_<name>.sql`
  (`IF NOT EXISTS`) **and** in `schema.sql`. Every query on tenant data must filter by `team_id`
  (there is no RLS).
- **Executor rules:** a new rule type must be added to the executor's `SUPPORTED_TABULAR_RULES`, the
  zod enum in `suggest-transforms`, and `RISK_THRESHOLDS` in `auto-validate`. `test_contracts.py`
  fails if they drift. Rules must raise `RuleSkipped` rather than half-apply.
- **Profiler/executor quality code:** the `SHARED QUALITY BLOCK` is copied in both handlers and
  must stay identical (`test_quality.py`).
- **Python dependencies** are exact-pinned in each `lambdas/*/requirements.txt`.
