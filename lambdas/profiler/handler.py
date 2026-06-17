import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "package"))

import json
import io
import re
import boto3
import psycopg2
import requests
import pandas as pd
import numpy as np

s3 = boto3.client("s3")
secrets = boto3.client("secretsmanager")

DOCUMENT_EXTENSIONS = {"pdf", "docx", "doc"}


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


def extract_text(file_bytes: bytes, fmt: str) -> str:
    if fmt == "pdf":
        import pdfplumber
        with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
            pages = [page.extract_text() or "" for page in pdf.pages]
        return "\n\n".join(pages)
    elif fmt == "docx":
        from docx import Document
        doc = Document(io.BytesIO(file_bytes))
        return "\n".join(p.text for p in doc.paragraphs)
    else:
        return file_bytes.decode("utf-8", errors="replace")


def profile_document(text: str) -> dict:
    words = text.split()
    lines = text.splitlines()

    email_count = len(re.findall(r'[\w.+-]+@[\w-]+\.\w+', text))
    phone_count = len(re.findall(r'\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b', text))
    ssn_count   = len(re.findall(r'\b\d{3}-\d{2}-\d{4}\b', text))
    cc_count    = len(re.findall(r'\b(?:\d{4}[- ]?){3}\d{4}\b', text))
    html_tags   = len(re.findall(r'<[^>]+>', text))
    blank_lines = sum(1 for l in lines if not l.strip())

    pii_count = email_count + phone_count + ssn_count + cc_count
    pii_penalty   = min(pii_count * 5, 40)
    html_penalty  = min(html_tags * 0.5, 20)
    blank_penalty = min(blank_lines / max(len(lines), 1) * 100 * 0.3, 20)
    quality_score = max(0, round(100 - pii_penalty - html_penalty - blank_penalty))

    doc_stats = {
        "word_count": len(words),
        "char_count": len(text),
        "blank_line_count": blank_lines,
        "pii_detected": {
            "emails": email_count,
            "phones": phone_count,
            "ssns": ssn_count,
            "credit_cards": cc_count,
        },
        "html_tag_count": html_tags,
        "sample_text": text[:500],
    }

    return {
        "quality_score": quality_score,
        "total_rows": len(lines),
        "null_percentage": 0.0,
        "duplicate_percentage": 0.0,
        "type_mismatch_count": 0,
        "outlier_count": 0,
        "column_stats": doc_stats,
    }


def load_dataframe(file_bytes: bytes, fmt: str) -> pd.DataFrame:
    buf = io.BytesIO(file_bytes)

    if fmt in ("csv", "txt"):
        sample = file_bytes[:4096].decode("utf-8", errors="replace")
        sep = "\t" if sample.count("\t") > sample.count(",") else ","
        return pd.read_csv(io.BytesIO(file_bytes), sep=sep, low_memory=False)

    elif fmt == "tsv":
        return pd.read_csv(buf, sep="\t", low_memory=False)

    elif fmt in ("json", "jsonl"):
        text = file_bytes.decode("utf-8", errors="replace").strip()
        if fmt == "jsonl":
            try:
                return pd.read_json(io.BytesIO(file_bytes), lines=True)
            except Exception:
                pass
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return pd.json_normalize(parsed)
            elif isinstance(parsed, dict):
                for v in parsed.values():
                    if isinstance(v, list):
                        return pd.json_normalize(v)
                return pd.json_normalize([parsed])
        except Exception:
            pass
        try:
            return pd.read_json(io.BytesIO(file_bytes), lines=True)
        except Exception:
            return pd.read_json(io.BytesIO(file_bytes))

    elif fmt in ("xlsx", "xls"):
        xl = pd.ExcelFile(buf)
        return xl.parse(xl.sheet_names[0])

    elif fmt == "xml":
        from lxml import etree
        root = etree.fromstring(file_bytes)
        rows = [{child.tag: child.text for child in elem} for elem in root]
        if not rows:
            rows = [{root.tag: root.text}]
        return pd.DataFrame(rows)

    else:
        raise ValueError(f"Unsupported format: {fmt}")


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

        # Determine mode
        if fmt in DOCUMENT_EXTENSIONS:
            mode = "document"
        elif fmt == "txt":
            # Try tabular first; fall back to document if < 3 columns
            try:
                df_test = load_dataframe(file_bytes, fmt)
                mode = "tabular" if len(df_test.columns) >= 3 else "document"
            except Exception:
                mode = "document"
        else:
            mode = "tabular"

        cur.execute("UPDATE pipeline_runs SET mode = %s WHERE id = %s", (mode, run_id))
        conn.commit()

        class _NpEncoder(json.JSONEncoder):
            def default(self, obj):
                if isinstance(obj, (np.integer,)): return int(obj)
                if isinstance(obj, (np.floating,)): return float(obj)
                if isinstance(obj, np.ndarray): return obj.tolist()
                return super().default(obj)

        if mode == "document":
            text = extract_text(file_bytes, fmt)
            # Save extracted text to S3 so executor can skip re-extraction
            text_key = "/".join(key.rsplit("/", 1)[:-1]) + "/extracted_text.txt"
            s3.put_object(Bucket=bucket, Key=text_key, Body=text.encode("utf-8"), ContentType="text/plain")
            profile = profile_document(text)
        else:
            df = load_dataframe(file_bytes, fmt)
            if df.empty or len(df.columns) <= 1:
                raise ValueError(
                    f"File could not be parsed as structured tabular data "
                    f"({len(df.columns)} column(s), {len(df)} row(s) detected). "
                    f"CleanStack requires structured data with multiple columns."
                )
            profile = compute_quality_score(df)

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
                json.dumps(profile.get("column_stats", {}), cls=_NpEncoder),
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
