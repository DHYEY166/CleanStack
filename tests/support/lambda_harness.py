"""Run the real Lambda handlers in-process against the test services.

Shared by tests/support/invoke_lambda.py (TS integration suite) and
tests/e2e/lambda_worker.py (Playwright suite). The handler code is the
production code; the only substitution is get_db_conn(), which in production
builds an RDS IAM token and connects over TLS. Here it is a plain psycopg2
connection to DATABASE_URL (the Postgres service container).

Refuses to run unless AWS_ENDPOINT_URL points at LocalStack, so a stray run
can never touch real AWS.
"""
import importlib.util
import os
import pathlib
import sys

import psycopg2

ROOT = pathlib.Path(__file__).resolve().parents[2]
LAMBDAS = ROOT / "lambdas"


def _assert_local():
    endpoint = os.environ.get("AWS_ENDPOINT_URL", "")
    if "localhost" not in endpoint and "127.0.0.1" not in endpoint and "localstack" not in endpoint:
        sys.exit(f"lambda_harness: AWS_ENDPOINT_URL={endpoint!r} is not LocalStack; refusing to run")
    if not os.environ.get("DATABASE_URL"):
        sys.exit("lambda_harness: DATABASE_URL is not set")
    os.environ.pop("SNS_DRIFT_TOPIC_ARN", None)


def load(name: str):
    """Import lambdas/<name>/handler.py with get_db_conn bound to DATABASE_URL."""
    _assert_local()
    spec = importlib.util.spec_from_file_location(f"cleanstack_{name}_handler", LAMBDAS / name / "handler.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    url = os.environ["DATABASE_URL"]
    module.get_db_conn = lambda: psycopg2.connect(url)
    return module
