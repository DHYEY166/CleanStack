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
from collections import Counter

s3 = boto3.client("s3")
secrets = boto3.client("secretsmanager")

DOCUMENT_EXTENSIONS = {"pdf", "docx", "doc"}

SENTINEL_VALUES = {
    "", "n/a", "na", "null", "none", "unknown", "undefined", "not available",
    "-", "--", "---", "?", "??", "0", "false", "nil", "nan", "missing",
    "n.a.", "n.a", "#n/a", "#null!", "tbd", "tbc", "pending", "not set",
}

DOMAIN_KEYWORDS = {
    "contract":  ["agreement", "clause", "party", "whereas", "hereinafter", "indemnify", "termination", "obligations"],
    "medical":   ["patient", "diagnosis", "prescription", "physician", "clinical", "dosage", "treatment", "symptoms"],
    "hr":        ["employee", "salary", "compensation", "performance", "payroll", "benefits", "onboarding", "recruiter"],
    "invoice":   ["invoice", "billing", "payment", "amount due", "vendor", "purchase order", "remittance", "net 30"],
    "legal":     ["plaintiff", "defendant", "court", "jurisdiction", "liability", "statute", "affidavit", "counsel"],
    "financial": ["revenue", "ebitda", "balance sheet", "fiscal", "quarterly", "dividend", "earnings", "amortization"],
}


def get_db_conn():
    from urllib.parse import urlparse
    url = os.environ["DATABASE_URL"]
    p = urlparse(url)
    host, port, user, dbname = p.hostname, p.port or 5432, p.username, p.path.lstrip("/")
    rds = boto3.client("rds", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    token = rds.generate_db_auth_token(DBHostname=host, Port=port, DBUsername=user)
    return psycopg2.connect(host=host, port=port, user=user, password=token, dbname=dbname, sslmode="require")


def detect_format(key: str, content_type: str) -> str:
    return key.rsplit(".", 1)[-1].lower()


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


def _val_pattern(val: str) -> str:
    s = re.sub(r'[A-Za-z]+', 'A', val)
    s = re.sub(r'\d+', 'N', s)
    return s


def profile_document(text: str) -> dict:
    lines = text.splitlines()
    words = text.split()
    non_blank_lines = [l for l in lines if l.strip()]

    # — PII counts —
    email_count = len(re.findall(r'[\w.+-]+@[\w-]+\.\w+', text))
    phone_count = len(re.findall(r'\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b', text))
    ssn_count   = len(re.findall(r'\b\d{3}-\d{2}-\d{4}\b', text))
    cc_count    = len(re.findall(r'\b(?:\d{4}[- ]?){3}\d{4}\b', text))
    html_tags   = len(re.findall(r'<[^>]+>', text))
    blank_lines = sum(1 for l in lines if not l.strip())

    # — Repeated lines (headers/footers) —
    line_counts = Counter(l.strip() for l in lines if l.strip() and len(l.strip()) < 150)
    repeated = {l: c for l, c in line_counts.items() if c >= 3}
    repeated_examples = dict(list(sorted(repeated.items(), key=lambda x: -x[1])[:5]))

    # — Line length distribution —
    lengths = [len(l) for l in non_blank_lines]
    avg_line_len  = round(sum(lengths) / max(len(lengths), 1), 1)
    short_line_pct = round(sum(1 for l in lengths if l < 40) / max(len(lengths), 1) * 100, 1)

    # — Encoding errors —
    enc_errors = re.findall(r'[â€™â€œÃ©Ã¨Ã®Ã´Ã ï»¿�â]', text)
    enc_error_examples = list({c for c in enc_errors})[:5]

    # — Named entity hints —
    person_matches = list(set(re.findall(r'\b[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}\b', text)))
    org_matches    = list(set(re.findall(
        r'\b[A-Z][A-Za-z\s]{2,30}(?:Inc|LLC|Ltd|LLP|Corp|Co|Company|Group|Holdings|Technologies|Solutions)\b', text
    )))

    # — Domain inference —
    text_lower = text.lower()
    domain_scores = {d: sum(text_lower.count(k) for k in kws) for d, kws in DOMAIN_KEYWORDS.items()}
    best_domain = max(domain_scores, key=domain_scores.get)
    domain_confidence = domain_scores[best_domain]
    inferred_domain = best_domain if domain_confidence >= 2 else "general"

    # — Quality score —
    pii_count      = email_count + phone_count + ssn_count + cc_count
    pii_penalty    = min(pii_count * 5, 40)
    html_penalty   = min(html_tags * 0.5, 20)
    blank_penalty  = min(blank_lines / max(len(lines), 1) * 100 * 0.3, 20)
    ner_penalty    = min(len(person_matches) * 1.5, 15)
    enc_penalty    = min(len(enc_errors) * 0.5, 10)
    header_penalty = min(len(repeated) * 1.0, 10)
    quality_score  = max(0, round(100 - pii_penalty - html_penalty - blank_penalty
                                  - ner_penalty - enc_penalty - header_penalty))

    mid = len(text) // 2
    doc_stats = {
        "word_count":             len(words),
        "char_count":             len(text),
        "blank_line_count":       blank_lines,
        "avg_line_length":        avg_line_len,
        "short_line_pct":         short_line_pct,
        "pii_detected": {
            "emails":       email_count,
            "phones":       phone_count,
            "ssns":         ssn_count,
            "credit_cards": cc_count,
        },
        "html_tag_count":         html_tags,
        "repeated_line_count":    len(repeated),
        "repeated_line_examples": repeated_examples,
        "encoding_error_count":   len(enc_errors),
        "encoding_error_examples": enc_error_examples,
        "person_name_count":      len(person_matches),
        "person_name_examples":   person_matches[:5],
        "org_count":              len(org_matches),
        "org_examples":           org_matches[:3],
        "inferred_domain":        inferred_domain,
        "domain_confidence":      domain_confidence,
        "sample_text":            text[:2000],
        "mid_sample_text":        text[mid: mid + 500],
    }

    return {
        "quality_score":        quality_score,
        "total_rows":           len(lines),
        "null_percentage":      0.0,
        "duplicate_percentage": 0.0,
        "type_mismatch_count":  0,
        "outlier_count":        0,
        "column_stats":         doc_stats,
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
    total_rows  = len(df)
    total_cols  = len(df.columns)

    null_count = df.isnull().sum().sum()
    null_pct   = round(null_count / total_cells * 100, 2)

    dup_count = df.duplicated().sum()
    dup_pct   = round(dup_count / max(total_rows, 1) * 100, 2)

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
        outlier_count += int(df[(df[col] < q1 - 1.5 * iqr) | (df[col] > q3 + 1.5 * iqr)][col].count())

    # Sentinel and whitespace — dataset-level aggregates
    total_sentinel_count = 0
    whitespace_padded_cols = 0

    column_stats = {}
    for col in df.columns:
        series = df[col]
        n = len(series)

        col_stat: dict = {
            "type":         str(series.dtype),
            "null_count":   int(series.isnull().sum()),
            "null_pct":     round(series.isnull().mean() * 100, 2),
            "unique_count": int(series.nunique()),
            "sample_values": [str(v) for v in series.dropna().head(20).tolist()],
        }

        if pd.api.types.is_numeric_dtype(series):
            col_stat["min"] = float(series.min()) if not series.empty else None
            col_stat["max"] = float(series.max()) if not series.empty else None
            # Outlier examples
            q1, q3 = series.quantile(0.25), series.quantile(0.75)
            iqr = q3 - q1
            outliers = series[(series < q1 - 1.5 * iqr) | (series > q3 + 1.5 * iqr)]
            col_stat["outlier_examples"] = [float(v) for v in outliers.head(3).tolist()]

        if series.dtype == object:
            str_series = series.astype(str).str.strip().str.lower()

            # Sentinel detection
            sentinel_count = int(str_series.isin(SENTINEL_VALUES).sum())
            col_stat["sentinel_count"] = sentinel_count
            col_stat["sentinel_pct"]   = round(sentinel_count / max(n, 1) * 100, 2)
            col_stat["true_null_pct"]  = round((col_stat["null_count"] + sentinel_count) / max(n, 1) * 100, 2)
            total_sentinel_count += sentinel_count

            # Sentinel examples (distinct values found)
            sentinel_vals_found = series.astype(str).str.strip()[
                series.astype(str).str.strip().str.lower().isin(SENTINEL_VALUES)
            ].unique().tolist()
            col_stat["sentinel_examples"] = [str(v) for v in sentinel_vals_found[:5]]

            # Whitespace-padded count
            raw_str = series.dropna().astype(str)
            padded = int((raw_str != raw_str.str.strip()).sum())
            col_stat["whitespace_padded_count"] = padded
            if padded > 0:
                whitespace_padded_cols += 1

            # String pattern diversity
            patterns = raw_str.apply(_val_pattern).value_counts().head(6)
            col_stat["string_patterns"]       = {str(k): int(v) for k, v in patterns.items()}
            col_stat["distinct_pattern_count"] = int(raw_str.apply(_val_pattern).nunique())

            # Value frequency for low-cardinality columns
            if series.nunique() <= 50:
                top10 = series.value_counts(dropna=False).head(10)
                col_stat["value_counts"] = {str(k): int(v) for k, v in top10.items()}

        column_stats[str(col)] = col_stat

    # Dataset-level sentinel pct
    total_object_cells = int(df.select_dtypes(include="object").size) or 1
    sentinel_pct_overall = round(total_sentinel_count / total_object_cells * 100, 2)

    # Penalties
    null_penalty     = min(null_pct * 0.5, 30)
    dup_penalty      = min(dup_pct * 0.3, 20)
    type_penalty     = min(type_mismatches * 5, 20)
    outlier_penalty  = min(outlier_count / max(total_rows, 1) * 100 * 0.1, 10)
    sentinel_penalty = min(sentinel_pct_overall * 0.4, 15)
    ws_penalty       = min(whitespace_padded_cols / max(total_cols, 1) * 100 * 0.1, 5)
    score = max(0, round(100 - null_penalty - dup_penalty - type_penalty
                         - outlier_penalty - sentinel_penalty - ws_penalty))

    return {
        "quality_score":          score,
        "total_rows":             total_rows,
        "null_percentage":        null_pct,
        "duplicate_percentage":   dup_pct,
        "type_mismatch_count":    type_mismatches,
        "outlier_count":          outlier_count,
        "sentinel_pct_overall":   sentinel_pct_overall,
        "whitespace_padded_cols": whitespace_padded_cols,
        "column_stats":           column_stats,
    }


def handler(event, context):
    record = event["Records"][0]["s3"]
    bucket = record["bucket"]["name"]
    key    = record["object"]["key"].replace("+", " ")

    parts = key.split("/")
    if len(parts) < 4:
        print(f"[profiler] Skipping non-run key: {key}")
        return {"statusCode": 200, "body": "skipped"}

    obj        = s3.get_object(Bucket=bucket, Key=key)
    file_bytes = obj["Body"].read()
    fmt        = detect_format(key, obj.get("ContentType", ""))
    run_id     = parts[2]

    conn = get_db_conn()
    cur  = conn.cursor()

    try:
        cur.execute(
            "UPDATE pipeline_runs SET status = 'profiling' WHERE id = %s AND status = 'pending' RETURNING id",
            (run_id,)
        )
        claimed = cur.fetchone()
        conn.commit()

        if not claimed:
            print(f"[profiler] Run {run_id} already claimed — skipping duplicate invocation")
            cur.close()
            conn.close()
            return {"statusCode": 200, "run_id": run_id, "skipped": True}

        if fmt in DOCUMENT_EXTENSIONS:
            mode = "document"
        elif fmt == "txt":
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
                if isinstance(obj, (np.integer,)):  return int(obj)
                if isinstance(obj, (np.floating,)): return float(obj)
                if isinstance(obj, np.ndarray):     return obj.tolist()
                return super().default(obj)

        if mode == "document":
            text = extract_text(file_bytes, fmt)
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

        app_url        = os.environ["APP_URL"]
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
