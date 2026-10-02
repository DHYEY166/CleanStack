#!/usr/bin/env bash
# Local quality gate: the same steps as .github/workflows/ci.yml.
#   ci/verify.sh            # web + lambdas (uses ./.venv or $PYTHON for pytest)
#   SKIP_BUILD=1 ci/verify.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PYTHON="${PYTHON:-}"
if [[ -z "$PYTHON" ]]; then
  if [[ -x .venv/bin/python ]]; then PYTHON=.venv/bin/python; else PYTHON=python3; fi
fi

step() { echo; echo "==> $*"; "$@"; }

step npm ci
step npx eslint
step npx tsc --noEmit
step npx vitest run
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then step npm run build; fi
step "$PYTHON" -m pytest -q lambdas/tests
echo; echo "All checks passed."
