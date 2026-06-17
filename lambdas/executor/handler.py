import json
import os
import io
import hashlib
import boto3
import psycopg2
import pandas as pd
import numpy as np

s3 = boto3.client("s3")
sns = boto3.client("sns")
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


def load_raw_dataframe(file_bytes: bytes, fmt: str) -> pd.DataFrame:
    buf = io.BytesIO(file_bytes)

    if fmt in ("csv", "txt"):
        sample = file_bytes[:4096].decode("utf-8", errors="replace")
        sep = "\t" if sample.count("\t") > sample.count(",") else ","
        return pd.read_csv(io.BytesIO(file_bytes), sep=sep, low_memory=False)
    elif fmt == "tsv":
        return pd.read_csv(buf, sep="\t", low_memory=False)
    elif fmt == "json":
        try:
            return pd.read_json(buf)
        except Exception:
            return pd.read_json(buf, lines=True)
    elif fmt == "jsonl":
        return pd.read_json(buf, lines=True)
    elif fmt in ("xlsx", "xls"):
        xl = pd.ExcelFile(buf)
        return xl.parse(xl.sheet_names[0])
    elif fmt == "xml":
        from lxml import etree
        root = etree.fromstring(file_bytes)
        rows = [{sub.tag: sub.text for sub in child} for child in root]
        return pd.DataFrame(rows)
    elif fmt == "parquet":
        return pd.read_parquet(buf)
    else:
        raise ValueError(f"Unsupported format for executor: {fmt}")


def _parse_params(raw) -> dict:
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except Exception:
            return {}
    return raw or {}


def _to_numeric_clean(series: pd.Series) -> pd.Series:
    """Strip currency symbols/commas then coerce to numeric."""
    cleaned = series.astype(str).str.replace(r"[$,\s]", "", regex=True)
    return pd.to_numeric(cleaned, errors="coerce")


def apply_transforms(df: pd.DataFrame, rules: list[dict]) -> pd.DataFrame:
    for rule in rules:
        rtype = rule["rule_type"]
        col = rule.get("column_name")
        params = _parse_params(rule.get("parameters"))

        try:
            if rtype == "drop_nulls":
                if col and col in df.columns:
                    threshold = params.get("threshold", 0.0)
                    if isinstance(threshold, (int, float)) and float(threshold) < 1.0:
                        min_count = int(len(df) * (1 - float(threshold)))
                        df = df.dropna(subset=[col], thresh=min_count)
                    else:
                        df = df.dropna(subset=[col])
                elif not col:
                    df = df.dropna()

            elif rtype == "deduplicate":
                subset = [col] if col and col in df.columns else None
                df = df.drop_duplicates(subset=subset, keep="first")

            elif rtype == "type_cast":
                if col and col in df.columns:
                    target = params.get("target_type", "str")
                    if target in ("float", "float64", "numeric", "number"):
                        df[col] = _to_numeric_clean(df[col])
                    elif target in ("int", "int64"):
                        df[col] = _to_numeric_clean(df[col]).astype("Int64")
                    elif target == "str":
                        df[col] = df[col].astype(str)
                    elif target in ("datetime", "date", "timestamp"):
                        df[col] = pd.to_datetime(df[col], infer_datetime_format=True, errors="coerce")
                        df[col] = df[col].dt.strftime("%Y-%m-%d")
                    else:
                        df[col] = df[col].astype(target, errors="ignore")

            elif rtype == "rename":
                if col and col in df.columns:
                    new_name = params.get("new_name")
                    if new_name:
                        df = df.rename(columns={col: new_name})

            elif rtype == "filter":
                if col and col in df.columns:
                    operator = params.get("operator", "notnull")
                    value = params.get("value")
                    if operator == "notnull":
                        df = df[df[col].notna()]
                    elif operator == "eq":
                        df = df[df[col] == value]
                    elif operator == "neq":
                        df = df[df[col] != value]
                    elif operator == "gt":
                        df = df[_to_numeric_clean(df[col]) > float(value)]
                    elif operator == "lt":
                        df = df[_to_numeric_clean(df[col]) < float(value)]

            elif rtype == "normalize":
                if col and col in df.columns:
                    if df[col].dtype == object:
                        # Try mixed-format date parsing (pandas 2.0+)
                        try:
                            parsed = pd.to_datetime(df[col], format="mixed", dayfirst=False, errors="coerce")
                        except Exception:
                            parsed = pd.to_datetime(df[col], infer_datetime_format=True, errors="coerce")
                        # For any still-NaT values, retry with dayfirst=True
                        mask = parsed.isna() & df[col].notna() & (df[col].astype(str) != "nan")
                        if mask.any():
                            retry = pd.to_datetime(df[col][mask], format="mixed", dayfirst=True, errors="coerce")
                            parsed[mask] = retry
                        if parsed.notna().sum() > len(df) * 0.3:
                            df[col] = parsed.dt.strftime("%Y-%m-%d")
                        else:
                            df[col] = df[col].astype(str).str.strip().str.lower()
                    else:
                        numeric = pd.to_numeric(df[col], errors="coerce")
                        col_min, col_max = numeric.min(), numeric.max()
                        if col_max > col_min:
                            df[col] = (numeric - col_min) / (col_max - col_min)

            elif rtype == "fill_nulls":
                if col and col in df.columns:
                    strategy = params.get("strategy", "value")
                    fill_value = params.get("value", "Uncategorized")
                    if strategy == "mean":
                        df[col] = df[col].fillna(_to_numeric_clean(df[col]).mean())
                    elif strategy == "median":
                        df[col] = df[col].fillna(_to_numeric_clean(df[col]).median())
                    elif strategy == "mode":
                        mode = df[col].mode()
                        df[col] = df[col].fillna(mode[0] if len(mode) > 0 else fill_value)
                    else:
                        df[col] = df[col].fillna(fill_value)

            elif rtype == "trim_whitespace":
                targets = [col] if (col and col in df.columns) else df.select_dtypes(include="object").columns.tolist()
                for c in targets:
                    df[c] = df[c].astype(str).str.strip()
                    df[c] = df[c].replace({"nan": None, "": None})

        except Exception as e:
            print(f"[executor] skipping rule {rtype} on {col}: {e}")

    return df


def compute_quality_profile(df: pd.DataFrame) -> dict:
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
        q1, q3 = df[col].quantile(0.25), df[col].quantile(0.75)
        iqr = q3 - q1
        outlier_count += int(
            df[(df[col] < q1 - 1.5 * iqr) | (df[col] > q3 + 1.5 * iqr)][col].count()
        )

    null_penalty = min(null_pct * 0.5, 30)
    dup_penalty = min(dup_pct * 0.3, 20)
    type_penalty = min(type_mismatches * 5, 20)
    outlier_penalty = min(outlier_count / max(total_rows, 1) * 100 * 0.1, 10)
    score = max(0, round(100 - null_penalty - dup_penalty - type_penalty - outlier_penalty))

    column_stats = {}
    for col in df.columns:
        series = df[col]
        stat = {
            "type": str(series.dtype),
            "null_count": int(series.isnull().sum()),
            "null_pct": round(series.isnull().mean() * 100, 2),
            "unique_count": int(series.nunique()),
            "sample_values": [str(v) for v in series.dropna().head(5).tolist()],
        }
        if pd.api.types.is_numeric_dtype(series):
            stat["min"] = float(series.min()) if not series.empty else None
            stat["max"] = float(series.max()) if not series.empty else None
        column_stats[str(col)] = stat

    return {
        "quality_score": score,
        "total_rows": total_rows,
        "null_percentage": null_pct,
        "duplicate_percentage": dup_pct,
        "type_mismatch_count": type_mismatches,
        "outlier_count": outlier_count,
        "column_stats": column_stats,
    }


def schema_hash(df: pd.DataFrame) -> tuple[str, dict]:
    col_defs = {str(col): str(df[col].dtype) for col in df.columns}
    h = hashlib.sha256(json.dumps(col_defs, sort_keys=True).encode()).hexdigest()
    return h, col_defs


def handler(event, context):
    record = event["Records"][0]
    body = json.loads(record["body"])
    run_id = body["run_id"]

    conn = get_db_conn()
    cur = conn.cursor()

    try:
        cur.execute(
            "UPDATE pipeline_runs SET status = 'running' WHERE id = %s",
            (run_id,)
        )
        conn.commit()

        # Fetch run metadata
        cur.execute(
            "SELECT pipeline_id, raw_s3_key, file_format FROM pipeline_runs WHERE id = %s",
            (run_id,)
        )
        row = cur.fetchone()
        pipeline_id, raw_s3_key, file_format = row

        # Fetch approved rules ordered by index
        cur.execute(
            """SELECT rule_type, column_name, parameters
               FROM transform_rules
               WHERE run_id = %s AND status = 'approved'
               ORDER BY order_index ASC""",
            (run_id,)
        )
        rules = [
            {"rule_type": r[0], "column_name": r[1], "parameters": r[2]}
            for r in cur.fetchall()
        ]

        # Read raw file from S3
        raw_bucket = os.environ["S3_RAW_BUCKET"]
        obj = s3.get_object(Bucket=raw_bucket, Key=raw_s3_key)
        file_bytes = obj["Body"].read()
        fmt = file_format or raw_s3_key.rsplit(".", 1)[-1].lower()

        df = load_raw_dataframe(file_bytes, fmt)
        df = apply_transforms(df, rules)

        # Write processed CSV to S3
        processed_bucket = os.environ["S3_PROCESSED_BUCKET"]
        processed_key = f"processed/{pipeline_id}/{run_id}/output.csv"
        csv_buf = io.BytesIO()
        df.to_csv(csv_buf, index=False)
        csv_buf.seek(0)
        s3.put_object(
            Bucket=processed_bucket,
            Key=processed_key,
            Body=csv_buf.getvalue(),
            ContentType="text/csv",
        )

        # Compute post-transform profile
        profile = compute_quality_profile(df)

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
               VALUES (%s, 'processed', %s, %s, %s, %s, %s, %s, %s)""",
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
            """UPDATE pipeline_runs
               SET status = 'completed',
                   processed_s3_key = %s,
                   row_count_processed = %s,
                   completed_at = now()
               WHERE id = %s""",
            (processed_key, profile["total_rows"], run_id),
        )
        conn.commit()

        # Schema drift detection
        new_hash, col_defs = schema_hash(df)

        cur.execute(
            """SELECT schema_hash FROM schema_snapshots
               WHERE pipeline_id = %s
               ORDER BY created_at DESC LIMIT 1""",
            (pipeline_id,)
        )
        last = cur.fetchone()

        cur.execute(
            """INSERT INTO schema_snapshots (pipeline_id, run_id, schema_hash, column_definitions)
               VALUES (%s, %s, %s, %s)""",
            (pipeline_id, run_id, new_hash, json.dumps(col_defs))
        )
        conn.commit()

        if last and last[0] != new_hash:
            sns_topic = os.environ.get("SNS_DRIFT_TOPIC_ARN")
            if sns_topic:
                sns.publish(
                    TopicArn=sns_topic,
                    Subject=f"Schema drift detected — pipeline {pipeline_id}",
                    Message=json.dumps({
                        "pipeline_id": pipeline_id,
                        "run_id": run_id,
                        "previous_hash": last[0],
                        "new_hash": new_hash,
                        "new_schema": col_defs,
                    }),
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
