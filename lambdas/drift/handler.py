import json
import os
import boto3
import psycopg2
import requests

secrets = boto3.client("secretsmanager")


def get_db_conn():
    secret = json.loads(
        secrets.get_secret_value(SecretId=os.environ["DB_SECRET_ARN"])["SecretString"]
    )
    host = secret["host"]
    port = secret.get("port", 5432)
    user = secret["username"]
    dbname = secret.get("dbname", "cleanstack")
    rds = boto3.client("rds", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    token = rds.generate_db_auth_token(DBHostname=host, Port=port, DBUsername=user)
    return psycopg2.connect(host=host, port=port, user=user, password=token, dbname=dbname, sslmode="require")


def compute_diff(old: dict, new: dict) -> dict:
    added = {col: new[col] for col in new if col not in old}
    removed = {col: old[col] for col in old if col not in new}
    type_changed = {
        col: {"from": old[col], "to": new[col]}
        for col in old
        if col in new and old[col] != new[col]
    }
    return {"added": added, "removed": removed, "type_changed": type_changed}


def format_slack_message(pipeline_id: str, run_id: str, diff: dict) -> dict:
    lines = [f"*Schema drift detected* in pipeline `{pipeline_id[:8]}…`"]

    if diff["added"]:
        lines.append("\n*Added columns:*")
        for col, dtype in diff["added"].items():
            lines.append(f"  ✅ `{col}` ({dtype})")

    if diff["removed"]:
        lines.append("\n*Removed columns:*")
        for col, dtype in diff["removed"].items():
            lines.append(f"  ❌ `{col}` ({dtype})")

    if diff["type_changed"]:
        lines.append("\n*Type changes:*")
        for col, change in diff["type_changed"].items():
            lines.append(f"  ⚠️ `{col}`: `{change['from']}` → `{change['to']}`")

    lines.append(f"\nRun ID: `{run_id}`")

    return {
        "text": "\n".join(lines),
        "username": "CleanStack",
        "icon_emoji": ":bar_chart:",
    }


def handler(event, context):
    for record in event["Records"]:
        sns_msg = json.loads(record["Sns"]["Message"])
        pipeline_id = sns_msg["pipeline_id"]
        run_id = sns_msg["run_id"]
        previous_hash = sns_msg.get("previous_hash")
        new_schema = sns_msg["new_schema"]

        conn = get_db_conn()
        cur = conn.cursor()

        try:
            old_schema = {}
            if previous_hash:
                cur.execute(
                    """SELECT column_definitions FROM schema_snapshots
                       WHERE pipeline_id = %s AND schema_hash = %s
                       ORDER BY created_at DESC LIMIT 1""",
                    (pipeline_id, previous_hash),
                )
                row = cur.fetchone()
                if row:
                    old_schema = row[0] if isinstance(row[0], dict) else json.loads(row[0])

            diff = compute_diff(old_schema, new_schema)

            # Load Slack webhook URL from pipeline_destinations
            cur.execute(
                """SELECT config FROM pipeline_destinations
                   WHERE pipeline_id = %s AND type = 'slack_alert' AND is_active = true
                   LIMIT 1""",
                (pipeline_id,),
            )
            dest = cur.fetchone()
            if dest:
                config = dest[0] if isinstance(dest[0], dict) else json.loads(dest[0])
                webhook_url = config.get("webhook_url")
                if webhook_url:
                    if not webhook_url.startswith("https://hooks.slack.com/"):
                        print(f"[drift] rejecting non-Slack webhook URL for pipeline {pipeline_id}")
                    else:
                        payload = format_slack_message(pipeline_id, run_id, diff)
                        requests.post(webhook_url, json=payload, timeout=10)

            # Log drift summary back to run (store in pipeline_runs error_message is wrong;
            # instead update the schema_snapshot row with diff JSONB)
            cur.execute(
                """UPDATE schema_snapshots
                   SET column_definitions = column_definitions || %s::jsonb
                   WHERE pipeline_id = %s AND run_id = %s""",
                (json.dumps({"_diff": diff}), pipeline_id, run_id),
            )
            conn.commit()

        except Exception as e:
            print(f"[drift] error processing pipeline {pipeline_id}: {e}")
            raise
        finally:
            cur.close()
            conn.close()

    return {"statusCode": 200}
