"""Integration tests: real Postgres + LocalStack S3/SQS, Lambda handlers called in-process.

Opt-in so `pytest lambdas/tests` (the unit suite) never needs containers:

    CLEANSTACK_INTEGRATION=1 python -m pytest lambdas/tests/integration

Without CLEANSTACK_INTEGRATION=1 every test here is skipped with that reason. With it,
unreachable services are a hard error (never a silent skip), so CI cannot pass vacuously.

Services: see tests/support/docker-compose.yml and tests/support/setup-services.mjs (buckets
with versioning, queues, schema + migrations). Defaults mirror tests/support/test-env.mjs.

What is NOT exercised: get_db_conn() (RDS IAM token over TLS). It is replaced with a plain
psycopg2 connection to DATABASE_URL; everything after the connection is the production code.
"""
import json
import os
import uuid

import pytest

ENABLED = os.environ.get("CLEANSTACK_INTEGRATION") == "1"

_LOCALSTACK = os.environ.get("LOCALSTACK_URL", "http://localhost.localstack.cloud:4566")
_DEFAULTS = {
    "DATABASE_URL": "postgres://postgres:postgres@localhost:5432/cleanstack",
    "AWS_REGION": "us-east-1",
    "AWS_DEFAULT_REGION": "us-east-1",
    "AWS_ACCESS_KEY_ID": "test",
    "AWS_SECRET_ACCESS_KEY": "test",
    "AWS_ENDPOINT_URL": _LOCALSTACK,
    "AWS_ENDPOINT_URL_S3": "http://s3.localhost.localstack.cloud:4566",
    "S3_RAW_BUCKET": "cleanstack-test-raw",
    "S3_PROCESSED_BUCKET": "cleanstack-test-processed",
    "SQS_QUEUE_URL": f"{_LOCALSTACK}/000000000000/cleanstack-test-executor",
    "RAW_EVENTS_QUEUE_URL": f"{_LOCALSTACK}/000000000000/cleanstack-test-raw-events",
    "APP_URL": "http://localhost:3000",
    "WEBHOOK_SECRET": "test-webhook-secret-0123456789abcdef0123",
}
if ENABLED:
    # Must happen before any handler module (and its module-level boto3 clients) is imported.
    for _k, _v in _DEFAULTS.items():
        if not os.environ.get(_k):
            os.environ[_k] = _v
    for _k in ("SNS_DRIFT_TOPIC_ARN", "AWS_PROFILE"):
        os.environ.pop(_k, None)


def pytest_collection_modifyitems(config, items):
    if ENABLED:
        return
    skip = pytest.mark.skip(reason="integration suite: set CLEANSTACK_INTEGRATION=1 and start the services")
    for item in items:
        if "/integration/" in str(item.fspath).replace("\\", "/"):
            item.add_marker(skip)


@pytest.fixture(scope="session")
def pg_url():
    return os.environ["DATABASE_URL"]


def _connect(url):
    import psycopg2
    return psycopg2.connect(url)


@pytest.fixture(scope="session")
def services(pg_url):
    """Fail loudly (not skip) if the containers are not reachable."""
    import boto3
    conn = _connect(pg_url)
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass('public.pipeline_runs')")
        if cur.fetchone()[0] is None:
            pytest.fail("schema not applied: run node tests/support/setup-services.mjs")
    conn.close()
    s3 = boto3.client("s3")
    for bucket in (os.environ["S3_RAW_BUCKET"], os.environ["S3_PROCESSED_BUCKET"]):
        status = s3.get_bucket_versioning(Bucket=bucket).get("Status")
        if status != "Enabled":
            pytest.fail(f"bucket {bucket} versioning is {status!r}; run tests/support/setup-services.mjs")
    return {"s3": s3, "sqs": boto3.client("sqs")}


@pytest.fixture
def db(pg_url, services):
    conn = _connect(pg_url)
    conn.autocommit = True
    yield conn
    conn.close()


def _patched(module, pg_url, monkeypatch):
    monkeypatch.setattr(module, "get_db_conn", lambda: _connect(pg_url))
    return module


@pytest.fixture
def live_executor(executor, pg_url, services, monkeypatch):
    return _patched(executor, pg_url, monkeypatch)


@pytest.fixture
def live_profiler(profiler, pg_url, services, monkeypatch):
    return _patched(profiler, pg_url, monkeypatch)


@pytest.fixture
def seed_run(db, services):
    """Insert pipeline + run (+ approved rules) and upload the raw file to LocalStack."""
    created = []

    def _seed(csv_bytes, rules=(), status="queued", auto_delete_raw=True):
        team = f"user_test_py_{uuid.uuid4().hex[:8]}"
        pipeline_id, run_id = str(uuid.uuid4()), str(uuid.uuid4())
        key = f"{team}/{pipeline_id}/{run_id}/raw.csv"
        with db.cursor() as cur:
            cur.execute(
                "INSERT INTO pipelines (id, name, owner_id, team_id, auto_delete_raw) VALUES (%s, 'it', %s, %s, %s)",
                (pipeline_id, team, team, auto_delete_raw),
            )
            cur.execute(
                "INSERT INTO pipeline_runs (id, pipeline_id, status, file_format, raw_s3_key, started_at) "
                "VALUES (%s, %s, %s, 'csv', %s, now())",
                (run_id, pipeline_id, status, key),
            )
            for idx, (rtype, col, params) in enumerate(rules):
                cur.execute(
                    "INSERT INTO transform_rules (pipeline_id, run_id, rule_type, column_name, parameters, status, order_index) "
                    "VALUES (%s, %s, %s, %s, %s, 'approved', %s)",
                    (pipeline_id, run_id, rtype, col, json.dumps(params), idx),
                )
        services["s3"].put_object(Bucket=os.environ["S3_RAW_BUCKET"], Key=key, Body=csv_bytes, ContentType="text/csv")
        created.append(pipeline_id)
        return {"team": team, "pipeline_id": pipeline_id, "run_id": run_id, "raw_key": key}

    yield _seed
    with db.cursor() as cur:
        for pid in created:
            cur.execute("DELETE FROM pipelines WHERE id = %s", (pid,))
