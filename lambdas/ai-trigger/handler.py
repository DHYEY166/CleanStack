import os
import json
import urllib.request
import urllib.error

APP_URL = os.environ["APP_URL"]
WEBHOOK_SECRET = os.environ["WEBHOOK_SECRET"]


def handler(event, context):
    for record in event.get("Records", []):
        try:
            body = json.loads(record["body"])
            run_id = body["run_id"]
        except (KeyError, json.JSONDecodeError) as e:
            print(f"[ai-trigger] bad message: {e} — {record.get('body','')[:200]}")
            continue

        print(f"[ai-trigger] triggering suggest-transforms for run {run_id}")

        payload = json.dumps({"run_id": run_id}).encode()
        req = urllib.request.Request(
            url=f"{APP_URL}/api/suggest-transforms",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "x-webhook-secret": WEBHOOK_SECRET,
            },
            method="POST",
        )

        try:
            # suggest-transforms can take up to 300s — Lambda timeout must match
            with urllib.request.urlopen(req, timeout=290) as resp:
                status = resp.status
                resp_body = resp.read().decode()[:500]
                print(f"[ai-trigger] suggest-transforms {status}: {resp_body}")
        except urllib.error.HTTPError as e:
            body_text = e.read().decode()[:500]
            print(f"[ai-trigger] suggest-transforms HTTP {e.code}: {body_text}")
            # Re-raise so SQS retries (up to maxReceiveCount=3 → DLQ)
            raise
        except Exception as e:
            print(f"[ai-trigger] error: {e}")
            raise

    return {"statusCode": 200}
