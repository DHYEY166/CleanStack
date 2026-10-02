"""Profiler triggered by a real LocalStack S3 -> SQS ObjectCreated notification."""
import json
import os
import uuid


def test_profiler_handles_real_s3_notification(live_profiler, services, db, monkeypatch):
    s3, sqs = services["s3"], services["sqs"]
    queue = os.environ["RAW_EVENTS_QUEUE_URL"]
    sqs.purge_queue(QueueUrl=queue)

    team = f"user_test_py_{uuid.uuid4().hex[:8]}"
    pipeline_id, run_id = str(uuid.uuid4()), str(uuid.uuid4())
    key = f"{team}/{pipeline_id}/{run_id}/raw.csv"
    with db.cursor() as cur:
        cur.execute("INSERT INTO pipelines (id, name, owner_id, team_id) VALUES (%s, 'it', %s, %s)", (pipeline_id, team, team))
        cur.execute("INSERT INTO pipeline_runs (id, pipeline_id, status, file_format, raw_s3_key) VALUES (%s, %s, 'pending', 'csv', %s)",
                    (run_id, pipeline_id, key))

    calls = []
    monkeypatch.setattr(live_profiler.requests, "post", lambda url, **kw: calls.append((url, kw)))
    try:
        s3.put_object(Bucket=os.environ["S3_RAW_BUCKET"], Key=key, ContentType="text/csv",
                      Body=b"id,name,amount\n1, Alice ,10\n2,Bob,\n3,Carol,30\n")
        event = None
        for _ in range(15):
            for m in sqs.receive_message(QueueUrl=queue, MaxNumberOfMessages=10, WaitTimeSeconds=1).get("Messages", []):
                body = json.loads(m["Body"])
                sqs.delete_message(QueueUrl=queue, ReceiptHandle=m["ReceiptHandle"])
                if any(r["s3"]["object"]["key"] == key for r in body.get("Records", [])):
                    event = body
            if event:
                break
        assert event is not None, "LocalStack did not deliver the S3 ObjectCreated notification"

        assert live_profiler.handler(event, None) == {"statusCode": 200, "run_id": run_id}
        with db.cursor() as cur:
            cur.execute("SELECT status, mode, row_count_raw FROM pipeline_runs WHERE id = %s", (run_id,))
            assert cur.fetchone() == ("awaiting_ai", "tabular", 3)
            cur.execute("SELECT total_rows, column_stats ? 'amount' FROM data_profiles WHERE run_id = %s AND stage = 'raw'", (run_id,))
            assert cur.fetchone() == (3, True)
        assert calls == [(f"{os.environ['APP_URL']}/api/webhooks/profile-complete",
                          {"json": {"run_id": run_id}, "headers": {"x-webhook-secret": os.environ["WEBHOOK_SECRET"]}, "timeout": 300})]

        # A duplicate notification for the same object is skipped by the conditional claim.
        assert live_profiler.handler(event, None) == {"statusCode": 200, "run_id": run_id, "skipped": True}
        assert len(calls) == 1
    finally:
        with db.cursor() as cur:
            cur.execute("DELETE FROM pipelines WHERE id = %s", (pipeline_id,))
