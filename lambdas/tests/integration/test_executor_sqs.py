"""Executor against real SQS deliveries, real S3 (versioned) and real Postgres."""
import csv
import io
import json
import os

import pytest

CSV = b"name,amount,order_date\n  Alice ,$10.50,2024-01-05\nBob,20,01/06/2024\n"
RULES = [
    ("trim_whitespace", None, {}),
    ("type_cast", "amount", {"target_type": "float"}),
    ("normalize", "order_date", {}),
]


def _deliver(sqs, run_id, copies=2):
    """Send the same body `copies` times (at-least-once duplicates), then receive them all as SQS records."""
    url = os.environ["SQS_QUEUE_URL"]
    sqs.purge_queue(QueueUrl=url)
    for _ in range(copies):
        sqs.send_message(QueueUrl=url, MessageBody=json.dumps({"run_id": run_id}))
    records = []
    for _ in range(10):
        resp = sqs.receive_message(QueueUrl=url, MaxNumberOfMessages=10, WaitTimeSeconds=1,
                                   AttributeNames=["ApproximateReceiveCount"])
        for m in resp.get("Messages", []):
            records.append({"messageId": m["MessageId"], "receiptHandle": m["ReceiptHandle"],
                            "body": m["Body"], "attributes": m.get("Attributes", {})})
            sqs.delete_message(QueueUrl=url, ReceiptHandle=m["ReceiptHandle"])
        if len(records) >= copies:
            break
    assert len(records) == copies, f"expected {copies} SQS deliveries, got {len(records)}"
    return records


def _run_row(db, run_id):
    with db.cursor() as cur:
        cur.execute("SELECT status, processed_s3_key, completed_at, row_count_processed, error_message "
                    "FROM pipeline_runs WHERE id = %s", (run_id,))
        return cur.fetchone()


def _count(db, sql, *args):
    with db.cursor() as cur:
        cur.execute(sql, args)
        return cur.fetchone()[0]


def _versions(s3, bucket, prefix):
    resp = s3.list_object_versions(Bucket=bucket, Prefix=prefix)
    return resp.get("Versions", []) + resp.get("DeleteMarkers", [])


def test_duplicate_sqs_message_processes_the_run_once(live_executor, services, db, seed_run):
    run = seed_run(CSV, RULES)
    s3, sqs = services["s3"], services["sqs"]
    first, second = _deliver(sqs, run["run_id"])

    assert live_executor.handler({"Records": [first]}, None) == {"statusCode": 200, "run_id": run["run_id"]}
    status, processed_key, completed_at, rows, err = _run_row(db, run["run_id"])
    assert (status, rows, err) == ("completed", 2, None)

    # The duplicate delivery is a no-op: it must not re-run, re-write, or flip the run.
    dup = live_executor.handler({"Records": [second]}, None)
    assert dup == {"statusCode": 200, "run_id": run["run_id"], "skipped": True}
    assert _run_row(db, run["run_id"]) == (status, processed_key, completed_at, rows, err)
    assert _count(db, "SELECT count(*) FROM data_profiles WHERE run_id = %s AND stage = 'processed'", run["run_id"]) == 1
    with db.cursor() as cur:
        cur.execute("SELECT rule_type, parameters->'_execution'->>'applied' FROM transform_rules "
                    "WHERE run_id = %s ORDER BY order_index", (run["run_id"],))
        assert cur.fetchall() == [(r[0], "true") for r in RULES]

    processed = os.environ["S3_PROCESSED_BUCKET"]
    out_versions = [v for v in _versions(s3, processed, processed_key) if v["Key"] == processed_key]
    assert len(out_versions) == 1, "duplicate delivery wrote the deliverable again"

    # Deliverable: no __orig_* sidecars; they live in the audit file next to it.
    body = s3.get_object(Bucket=processed, Key=processed_key)["Body"].read().decode()
    rows_out = list(csv.DictReader(io.StringIO(body)))
    assert list(rows_out[0].keys()) == ["name", "amount", "order_date"]
    assert rows_out[0] == {"name": "Alice", "amount": "10.5", "order_date": "2024-01-05"}
    audit_key = live_executor.audit_key_for(processed_key)
    audit_header = s3.get_object(Bucket=processed, Key=audit_key)["Body"].read().decode().splitlines()[0]
    assert "__orig_amount" in audit_header

    # Privacy: every version of the raw upload is gone (versioned bucket).
    assert _versions(s3, os.environ["S3_RAW_BUCKET"], run["raw_key"].rsplit("/", 1)[0] + "/") == []


def test_duplicates_in_one_batch_are_processed_once(live_executor, services, db, seed_run):
    run = seed_run(CSV, RULES)
    records = _deliver(services["sqs"], run["run_id"])
    result = live_executor.handler({"Records": records}, None)
    assert result["statusCode"] == 200
    assert [r.get("skipped", False) for r in result["results"]] == [False, True]
    assert _run_row(db, run["run_id"])[0] == "completed"
    assert _count(db, "SELECT count(*) FROM data_profiles WHERE run_id = %s AND stage = 'processed'", run["run_id"]) == 1


def test_failed_attempt_releases_the_claim_and_redelivery_succeeds(live_executor, services, db, seed_run):
    run = seed_run(CSV, RULES)
    s3 = services["s3"]
    raw = os.environ["S3_RAW_BUCKET"]
    s3.delete_object(Bucket=raw, Key=run["raw_key"])  # first attempt cannot read the upload

    first = {"body": json.dumps({"run_id": run["run_id"]}), "attributes": {"ApproximateReceiveCount": "1"}}
    with pytest.raises(RuntimeError, match="executor will retry"):
        live_executor.handler({"Records": [first]}, None)
    status, *_rest, err = _run_row(db, run["run_id"])
    assert status == "queued" and err.startswith("Attempt 1/3 failed")

    s3.put_object(Bucket=raw, Key=run["raw_key"], Body=CSV, ContentType="text/csv")
    second = {"body": first["body"], "attributes": {"ApproximateReceiveCount": "2"}}
    assert live_executor.handler({"Records": [second]}, None) == {"statusCode": 200, "run_id": run["run_id"]}
    assert _run_row(db, run["run_id"])[0] == "completed"


def test_last_attempt_marks_the_run_failed(live_executor, services, db, seed_run):
    run = seed_run(CSV, RULES)
    services["s3"].delete_object(Bucket=os.environ["S3_RAW_BUCKET"], Key=run["raw_key"])
    last = {"body": json.dumps({"run_id": run["run_id"]}), "attributes": {"ApproximateReceiveCount": "3"}}
    result = live_executor.handler({"Records": [last]}, None)
    assert result["failed"] is True
    assert _run_row(db, run["run_id"])[0] == "failed"
