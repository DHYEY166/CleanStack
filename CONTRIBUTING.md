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

CI (`ci/github-actions-ci.yml`, to be moved into `.github/workflows/`) runs the same commands. It
also runs pytest against pandas 3.0.6, because the production pandas layer version is not pinned in
this repo. If your change touches the Lambdas, run that too:

```bash
pip install pandas==3.0.6 numpy==2.5.3 && python -m pytest -q lambdas/tests
```

## Conventions

- **Configuration:** read environment variables through `src/lib/env.ts` (`requireEnv`,
  `optionalEnv`, `awsRegion`). Add new variables to `ENV_SPEC` and `.env.example`; a test enforces
  the latter.
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
