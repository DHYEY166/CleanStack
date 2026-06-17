import json
import os
import io
import boto3
import psycopg2
import requests
import pandas as pd
import numpy as np

s3 = boto3.client("s3")
secrets = boto3.client("secretsmanager")


def get_db_conn():
    from urllib.parse import urlparse
    url = os.environ["DATABASE_URL"]
    p = urlparse(url)
    host, port, user, dbname = p.hostname, p.port or 5432, p.username, p.path.lstrip("/")
    rds = boto3.client("rds", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    token = rds.generate_db_auth_token(DBHostname=host, Port=port, DBUsername=user)
    return psycopg2.connect(host=host, port=port, user=user, password=token, dbname=dbname, sslmode="require")


def detect_format(key: str, content_type: str) -> str:
    ext = key.rsplit(".", 1)[-1].lower()
    return ext


def load_dataframe(file_bytes: bytes, fmt: str) -> pd.DataFrame:
    buf = io.BytesIO(file_bytes)

    if fmt in ("csv", "txt"):
        sample = file_bytes[:4096].decode("utf-8", errors="replace")
        sep = "\t" if sample.count("\t") > sample.count(",") else ","
        return pd.read_csv(io.BytesIO(file_bytes), sep=sep, low_memory=False)

    elif fmt == "tsv":
        return pd.read_csv(buf, sep="\t", low_memory=False)

    elif fmt in ("json",):
        try:
            return pd.read_json(buf)
        except Exception:
            return pd.read_json(buf, lines=True)

    elif fmt == "jsonl":
        return pd.read_json(buf, lines=True)

    elif fmt in ("xlsx", "xls"):
        xl = pd.ExcelFile(buf)
        return xl.parse(xl.sheet_names[0])

    else:
        raise ValueError(f"Unsupported format: {fmt}. Supported: csv, tsv, json, jsonl, xlsx, xls")


def compute_quality_score(df: pd.DataFrame) -> dict:
    total_cells = df.size or 1
    total_rows = len(df)

    null_count = df.isnull().sum().sum()
    null_pct = round(null_count / total_cells * 100, 2)

    dup_count = df.duplicated().sum()
    dup_pct = round(dup_count / max(total_rows, 1) * 100, 2)

    type_mismatches = 0
    for col in df.columns:
        if df[col].dtype == object:
            numeric_count = pd.to_numeric(df[col], errors="coerce").notna().sum()
            if 0 < numeric_count < len(df[col]):
                type_mismatches += 1

    outlier_count = 0
    for col in df.select_dtypes(include=[np.number]).columns:
        q1 = df[col].quantile(0.25)
        q3 = df[col].quantile(0.75)
        iqr = q3 - q1
        outliers = df[(df[col] < q1 - 1.5 * iqr) | (df[col] > q3 + 1.5 * iqr)][col].count()
        outlier_count += int(outliers)

    null_penalty = min(null_pct * 0.5, 30)
    dup_penalty = min(dup_pct * 0.3, 20)
    type_penalty = min(type_mismatches * 5, 20)
    outlier_penalty = min(outlier_count / max(total_rows, 1) * 100 * 0.1, 10)
    score = max(0, round(100 - null_penalty - dup_penalty - type_penalty - outlier_penalty))

    column_stats = {}
    for col in df.columns:
        series = df[col]
        col_stat = {
            "type": str(series.dtype),
            "null_count": int(series.isnull().sum()),
            "null_pct": round(series.isnull().mean() * 100, 2),
            "unique_count": int(series.nunique()),
            "sample_values": [str(v) for v in series.dropna().head(5).tolist()],
        }
        if pd.api.types.is_numeric_dtype(series):
            col_stat["min"] = float(series.min()) if not series.empty else None
            col_stat["max"] = float(series.max()) if not series.empty else None
        column_stats[str(col)] = col_stat

    return {
        "quality_score": score,
        "total_rows": total_rows,
        "null_percentage": null_pct,
        "duplicate_percentage": dup_pct,
        "type_mismatch_count": type_mismatches,
        "outlier_count": outlier_count,
        "column_stats": column_stats,
    }


def handler(event, context):
    record = event["Records"][0]["s3"]
    bucket = record["bucket"]["name"]
    key = record["object"]["key"].replace("+", " ")

    obj = s3.get_object(Bucket=bucket, Key=key)
    file_bytes = obj["Body"].read()
    fmt = detect_format(key, obj.get("ContentType", ""))

    run_id = key.split("/")[2]

    conn = get_db_conn()
    cur = conn.cursor()

    try:
        cur.execute(
            "UPDATE pipeline_runs SET status = 'profiling' WHERE id = %s",
            (run_id,)
        )
        conn.commit()

        df = load_dataframe(file_bytes, fmt)
        profile = compute_quality_score(df)

        class _NpEncoder(json.JSONEncoder):
            def default(self, obj):
                if isinstance(obj, (np.integer,)): return int(obj)
                if isinstance(obj, (np.floating,)): return float(obj)
                if isinstance(obj, np.ndarray): return obj.tolist()
                return super().default(obj)

        cur.execute(
            """INSERT INTO data_profiles
               (run_id, stage, quality_score, total_rows, null_percentage,
                duplicate_percentage, type_mismatch_count, outlier_count, column_stats)
               VALUES (%s, 'raw', %s, %s, %s, %s, %s, %s, %s)""",
            (
                run_id,
                float(profile["quality_score"]),
                int(profile["total_rows"]),
                float(profile["null_percentage"]),
                float(profile["duplicate_percentage"]),
                int(profile["type_mismatch_count"]),
                int(profile["outlier_count"]),
                json.dumps(profile["column_stats"], cls=_NpEncoder),
            ),
        )

        cur.execute(
            "UPDATE pipeline_runs SET status = 'awaiting_ai', row_count_raw = %s WHERE id = %s",
            (profile["total_rows"], run_id),
        )
        conn.commit()

        app_url = os.environ["APP_URL"]
        webhook_secret = os.environ["WEBHOOK_SECRET"]
        requests.post(
            f"{app_url}/api/webhooks/profile-complete",
            json={"run_id": run_id},
            headers={"x-webhook-secret": webhook_secret},
            timeout=10,
        )

    except Exception as e:
        conn.rollback()
        cur.execute(
            "UPDATE pipeline_runs SET status = 'failed', error_message = %s WHERE id = %s",
            (str(e), run_id),
        )
        conn.commit()
        raise
    finally:
        cur.close()
        conn.close()

    return {"statusCode": 200, "run_id": run_id}
