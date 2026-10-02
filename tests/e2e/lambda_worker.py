"""E2E stand-in for the deployed Lambda triggers, running the real handlers in-process.

- raw-events queue (LocalStack S3 ObjectCreated notifications on the raw bucket)
  -> profiler handler, exactly like the S3 trigger in production.
- executor queue (messages from /api/approve-rules) -> executor handler, with
  Lambda's SQS semantics: delete on success, leave for redelivery on failure.

Started by playwright.config.ts as a webServer; prints "lambda worker ready"
once both queues are reachable. Only get_db_conn is substituted (see
tests/support/lambda_harness.py), and it refuses to run against real AWS.
"""
import json
import os
import signal
import sys
import time
import traceback

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "support"))
from lambda_harness import load  # noqa: E402

import boto3  # noqa: E402

running = True


def _stop(*_):
    global running
    running = False


signal.signal(signal.SIGTERM, _stop)
signal.signal(signal.SIGINT, _stop)


def log(msg):
    print(f"[lambda-worker] {msg}", flush=True)


def main():
    profiler = load("profiler")
    executor = load("executor")
    sqs = boto3.client("sqs")
    raw_q, exec_q = os.environ["RAW_EVENTS_QUEUE_URL"], os.environ["SQS_QUEUE_URL"]
    for q in (raw_q, exec_q):
        for _ in range(60):
            try:
                sqs.get_queue_attributes(QueueUrl=q, AttributeNames=["QueueArn"])
                break
            except Exception:
                time.sleep(1)
        else:
            sys.exit(f"queue {q} not reachable; run node tests/support/setup-services.mjs")
    # Start clean: notifications/messages left by earlier runs refer to deleted objects.
    for q in (raw_q, exec_q):
        sqs.purge_queue(QueueUrl=q)
    log("lambda worker ready")

    while running:
        for m in sqs.receive_message(QueueUrl=raw_q, MaxNumberOfMessages=10, WaitTimeSeconds=1).get("Messages", []):
            body = json.loads(m["Body"])
            for record in body.get("Records", []):
                key = record["s3"]["object"]["key"]
                if not key.rsplit("/", 1)[-1].startswith("raw."):
                    continue  # e.g. extracted_text.txt written by the profiler itself
                log(f"profiler <- s3://{record['s3']['bucket']['name']}/{key}")
                try:
                    log(f"profiler -> {profiler.handler({'Records': [record]}, None)}")
                except Exception:
                    traceback.print_exc()
            sqs.delete_message(QueueUrl=raw_q, ReceiptHandle=m["ReceiptHandle"])

        resp = sqs.receive_message(QueueUrl=exec_q, MaxNumberOfMessages=10, WaitTimeSeconds=1,
                                   AttributeNames=["ApproximateReceiveCount"])
        for m in resp.get("Messages", []):
            record = {"messageId": m["MessageId"], "body": m["Body"], "attributes": m.get("Attributes", {})}
            log(f"executor <- {m['Body']}")
            try:
                log(f"executor -> {executor.handler({'Records': [record]}, None)}")
                sqs.delete_message(QueueUrl=exec_q, ReceiptHandle=m["ReceiptHandle"])
            except Exception:
                traceback.print_exc()  # left on the queue: redelivered after the visibility timeout
    log("stopped")


if __name__ == "__main__":
    main()
