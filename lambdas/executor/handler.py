import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "package"))

try:
    import sentry_sdk
    from sentry_sdk.integrations.aws_lambda import AwsLambdaIntegration
    sentry_sdk.init(
        dsn=os.environ.get("SENTRY_DSN", ""),
        integrations=[AwsLambdaIntegration(timeout_warning=True)],
        traces_sample_rate=0.1,
    )
except ImportError:
    pass

import json
import io
import re
import hashlib
import math
import time
import boto3
import psycopg2
import pandas as pd
import numpy as np

DOCUMENT_EXTENSIONS = {"pdf", "docx"}

# Audit columns holding pre-clean values. They live only in audit.csv, never in the deliverable.
SIDECAR_PREFIX = "__orig_"

# === BEGIN SHARED QUALITY BLOCK ===
# This block is kept identical in lambdas/profiler/handler.py and lambdas/executor/handler.py so raw and
# processed quality scores use the same loader and formula (review M1). Each Lambda is
# deployed as a standalone zip, so it is copied rather than imported.
# lambdas/tests/test_quality.py fails if the two copies diverge.

SENTINEL_VALUES = {
    # Explicit null markers
    "", "n/a", "na", "null", "none", "unknown", "undefined", "not available",
    "not applicable", "not provided", "not specified", "not given",
    # Punctuation sentinels
    "-", "--", "---", "----", ".", "..", "...",
    "?", "??", "???", "#", "##",
    # Coded sentinels — unambiguous null-proxy numbers only
    "00", "000", "99", "999", "9999", "99999", "-99", "-999",
    # Boolean-as-sentinel (nil/nan/missing/void are unambiguous; "false" and "0" are valid data)
    "nil", "nan", "missing", "void",
    # State sentinels (excludes "pending" — valid status value in workflow/ticket/order datasets)
    "n.a.", "n.a", "#n/a", "#null!", "tbd", "tbc", "not set",
    "to be determined", "to be confirmed", "unknown value",
    # Excel/CSV export artifacts — always invalid in real data
    "#value!", "#ref!", "#div/0!", "#name?", "#num!", "#error!",
    "error", "err", "null value", "blank", "empty",
    # Numeric as string — inf/-inf are unambiguous; 0/0.0/-1 removed (valid in real data)
    "inf", "-inf",
}

def _is_text(series: pd.Series) -> bool:
    """True for string-like columns under both pandas 2 (object) and pandas 3 (str dtype)."""
    return series.dtype == object or isinstance(series.dtype, pd.StringDtype)


def _text_cols(df: pd.DataFrame) -> list:
    """All string-like columns (pandas 2 object and pandas 3 str dtypes)."""
    return [c for c in df.columns if _is_text(df[c])]


def _dtype_name(series: pd.Series) -> str:
    """Stable dtype label across pandas versions (pandas 3 reports text columns as "str")."""
    return "object" if _is_text(series) else str(series.dtype)


def detect_encoding(file_bytes: bytes) -> str:
    try:
        import chardet
        result = chardet.detect(file_bytes[:8192])
        enc = result.get("encoding") or "utf-8"
        confidence = result.get("confidence", 0.0)
        return enc if confidence > 0.7 else "utf-8"
    except ImportError:
        return "utf-8"


def _val_pattern(val: str) -> str:
    s = re.sub(r'[A-Za-z]+', 'A', val)
    s = re.sub(r'\d+', 'N', s)
    return s


def load_dataframe(file_bytes: bytes, fmt: str) -> pd.DataFrame:
    buf = io.BytesIO(file_bytes)

    if fmt == "csv":
        encoding = detect_encoding(file_bytes)
        sample = file_bytes[:4096].decode(encoding, errors="replace")
        sep = "\t" if sample.count("\t") > sample.count(",") else ","
        return pd.read_csv(
            io.BytesIO(file_bytes), sep=sep,
            dtype=str, keep_default_na=False, low_memory=False,
            encoding=encoding, encoding_errors="replace",
        )
    elif fmt == "txt":
        encoding = detect_encoding(file_bytes)
        sample = file_bytes[:4096].decode(encoding, errors="replace")
        counts = {s: sample.count(s) for s in [",", "\t", "|", ";"]}
        sep = max(counts, key=counts.get)
        if counts[sep] < 2:
            return pd.read_csv(
                io.BytesIO(file_bytes), sep=r'\s+',
                dtype=str, keep_default_na=False, engine='python',
                encoding=encoding, encoding_errors="replace",
            )
        return pd.read_csv(
            io.BytesIO(file_bytes), sep=sep,
            dtype=str, keep_default_na=False, low_memory=False,
            encoding=encoding, encoding_errors="replace",
        )
    elif fmt == "tsv":
        encoding = detect_encoding(file_bytes)
        return pd.read_csv(
            buf, sep="\t",
            dtype=str, keep_default_na=False, low_memory=False,
            encoding=encoding, encoding_errors="replace",
        )
    elif fmt in ("json", "jsonl"):
        text = file_bytes.decode("utf-8", errors="replace").strip()
        if fmt == "jsonl":
            # Strip comment lines before parsing
            lines = [l for l in text.splitlines() if not l.strip().startswith("//")]
            text_clean = "\n".join(lines)
            try:
                return pd.read_json(io.BytesIO(text_clean.encode()), lines=True)
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
        df = xl.parse(xl.sheet_names[0], dtype=str, keep_default_na=False)
        # Forward-fill merged cells (NaN after merge top-left = merged cell artifact)
        df = df.ffill(axis=0)
        return df
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

    # keep_default_na=False: empty cells are "" not NaN — exclude them before type-mismatch check
    type_mismatches = 0
    for col in df.columns:
        if _is_text(df[col]):
            non_empty = df[col][df[col].astype(str).str.strip() != ""]
            numeric_count = pd.to_numeric(non_empty, errors="coerce").notna().sum()
            if 0 < numeric_count < len(non_empty):
                type_mismatches += 1

    # dtype=str: coerce object cols to numeric before outlier detection
    outlier_count = 0
    for col in df.columns:
        _num = pd.to_numeric(df[col], errors="coerce") if _is_text(df[col]) else df[col]
        if _num.notna().sum() < max(len(_num) * 0.5, 2):
            continue
        q1, q3 = _num.quantile(0.25), _num.quantile(0.75)
        iqr = q3 - q1
        if iqr > 0:
            outlier_count += int(((_num < q1 - 1.5 * iqr) | (_num > q3 + 1.5 * iqr)).sum())

    # Sentinel and whitespace — dataset-level aggregates
    total_sentinel_count = 0
    whitespace_padded_cols = 0

    column_stats = {}
    for col in df.columns:
        series = df[col]
        n = len(series)

        col_stat: dict = {
            "type":         _dtype_name(series),
            "null_count":   int(series.isnull().sum()),
            "null_pct":     round(series.isnull().mean() * 100, 2),
            "unique_count": int(series.nunique()),
            "sample_values": [
                str(v) if isinstance(v, (int, float)) and abs(v) > 1e15 else v
                for v in series.dropna().head(20).tolist()
            ],
        }

        # dtype=str: try numeric coercion for min/max/outlier stats
        _num_series = series if pd.api.types.is_numeric_dtype(series) else pd.to_numeric(series, errors="coerce")
        if _num_series.notna().sum() >= max(len(_num_series) * 0.5, 2):
            col_stat["min"] = float(_num_series.min()) if not _num_series.empty else None
            col_stat["max"] = float(_num_series.max()) if not _num_series.empty else None
            q1, q3 = _num_series.quantile(0.25), _num_series.quantile(0.75)
            iqr = q3 - q1
            if iqr > 0:
                outliers = _num_series[(_num_series < q1 - 1.5 * iqr) | (_num_series > q3 + 1.5 * iqr)]
                col_stat["outlier_examples"] = [float(v) for v in outliers.head(3).tolist()]

        if _is_text(series):
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
    total_object_cells = int(len(df) * len(_text_cols(df))) or 1
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

# === END SHARED QUALITY BLOCK ===


s3 = boto3.client("s3")
sns = boto3.client("sns")
secrets = boto3.client("secretsmanager")


class _NpEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, np.integer): return int(obj)
        if isinstance(obj, np.floating): return None if np.isnan(obj) else float(obj)
        if isinstance(obj, np.ndarray): return obj.tolist()
        return super().default(obj)

def _sanitize_nan(obj):
    """Recursively replace float NaN/Inf with None so PostgreSQL JSON accepts it."""
    if isinstance(obj, float) and (obj != obj or obj == float('inf') or obj == float('-inf')):
        return None
    if isinstance(obj, dict):
        return {k: _sanitize_nan(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize_nan(v) for v in obj]
    return obj


def save_dataframe(df: pd.DataFrame, fmt: str) -> tuple[bytes, str, str]:
    """Return (file_bytes, content_type, extension) in native format."""
    if fmt == "csv":
        buf = io.BytesIO()
        df.to_csv(buf, index=False)
        return buf.getvalue(), "text/csv", "csv"

    elif fmt == "txt":
        buf = io.BytesIO()
        df.to_csv(buf, index=False)
        return buf.getvalue(), "text/plain", "txt"

    elif fmt == "tsv":
        buf = io.BytesIO()
        df.to_csv(buf, sep="\t", index=False)
        return buf.getvalue(), "text/tab-separated-values", "tsv"

    elif fmt == "json":
        json_str = df.to_json(orient="records", indent=2, force_ascii=False)
        return (json_str or "[]").encode("utf-8"), "application/json", "json"

    elif fmt == "jsonl":
        json_str = df.to_json(orient="records", lines=True, force_ascii=False)
        return (json_str or "").encode("utf-8"), "application/x-ndjson", "jsonl"

    elif fmt in ("xlsx", "xls"):
        buf = io.BytesIO()
        df.to_excel(buf, index=False, engine="openpyxl")
        return buf.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"

    elif fmt == "xml":
        from lxml import etree
        root = etree.Element("records")
        for _, row in df.iterrows():
            record = etree.SubElement(root, "record")
            for col, val in row.items():
                child = etree.SubElement(record, str(col).replace(" ", "_"))
                child.text = "" if (val is None or (isinstance(val, float) and np.isnan(val))) else str(val)
        xml_bytes = etree.tostring(root, pretty_print=True, xml_declaration=True, encoding="UTF-8")
        return xml_bytes, "application/xml", "xml"

    elif fmt == "parquet":
        buf = io.BytesIO()
        df.to_parquet(buf, index=False, engine="pyarrow")
        return buf.getvalue(), "application/octet-stream", "parquet"

    else:
        buf = io.BytesIO()
        df.to_csv(buf, index=False)
        return buf.getvalue(), "text/csv", "csv"


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


def apply_transforms_pdf(file_bytes: bytes, rules: list[dict]) -> tuple[bytes, str, str]:
    import fitz  # PyMuPDF

    doc = fitz.open(stream=file_bytes, filetype="pdf")

    for page in doc:
        page_text = page.get_text("text")

        for rule in rules:
            rtype = rule["rule_type"]
            params = _parse_params_simple(rule.get("parameters", {}))
            try:
                if rtype == "strip_pii":
                    patterns = [
                        r'[\w.+-]+@[\w-]+\.\w+',
                        r'\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b',
                        r'\b\d{3}-\d{2}-\d{4}\b',
                        r'\b(?:\d{4}[- ]?){3}\d{4}\b',
                    ]
                    replacements = ["[EMAIL REDACTED]", "[PHONE REDACTED]", "[SSN REDACTED]", "[CC REDACTED]"]
                    for pat, repl in zip(patterns, replacements):
                        for match in set(re.findall(pat, page_text)):
                            for area in page.search_for(match):
                                page.add_redact_annot(area, text=repl, fontsize=8)

                elif rtype == "redact_pattern":
                    pattern = params.get("pattern", "")
                    replacement = str(params.get("replacement", "[REDACTED]"))
                    if pattern:
                        if len(pattern) > 200:
                            print(f"[executor] PDF redact_pattern too long ({len(pattern)} chars), skipping")
                        else:
                            try:
                                compiled_pdf = re.compile(pattern)
                            except re.error as regex_err:
                                print(f"[executor] PDF redact_pattern invalid regex: {regex_err}")
                                compiled_pdf = None
                            if compiled_pdf:
                                for match in set(compiled_pdf.findall(page_text)):
                                    for area in page.search_for(str(match)):
                                        page.add_redact_annot(area, text=replacement, fontsize=8)

                elif rtype == "remove_headers_footers":
                    from collections import Counter
                    lines = page_text.splitlines()
                    counts = Counter(l.strip() for l in lines if l.strip())
                    for line, cnt in counts.items():
                        if cnt >= 2 and len(line) < 120:
                            for area in page.search_for(line):
                                page.add_redact_annot(area)

            except Exception as e:
                print(f"[executor] PDF rule {rtype} failed: {e}")

        page.apply_redactions()

    buf = io.BytesIO()
    doc.save(buf, deflate=True)
    doc.close()
    return buf.getvalue(), "application/pdf", "pdf"


def apply_transforms_docx(file_bytes: bytes, rules: list[dict]) -> tuple[bytes, str, str]:
    from docx import Document

    doc = Document(io.BytesIO(file_bytes))

    def fix_paragraph(para):
        if not para.text.strip():
            return
        new_text = apply_document_transforms(para.text, rules)
        if new_text == para.text:
            return
        if para.runs:
            para.runs[0].text = new_text
            for run in para.runs[1:]:
                run.text = ""

    for para in doc.paragraphs:
        fix_paragraph(para)
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                for para in cell.paragraphs:
                    fix_paragraph(para)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"


def apply_document_transforms(text: str, rules: list[dict]) -> str:
    for rule in rules:
        rtype = rule["rule_type"]
        params = _parse_params_simple(rule.get("parameters", {}))
        try:
            if rtype == "strip_pii":
                text = re.sub(r'[\w.+-]+@[\w-]+\.\w+', '[EMAIL REDACTED]', text)
                text = re.sub(r'\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b', '[PHONE REDACTED]', text)
                text = re.sub(r'\b\d{3}-\d{2}-\d{4}\b', '[SSN REDACTED]', text)
                text = re.sub(r'\b(?:\d{4}[- ]?){3}\d{4}\b', '[CC REDACTED]', text)

            elif rtype == "normalize_whitespace":
                text = re.sub(r'[ \t]+', ' ', text)
                text = re.sub(r'\n{3,}', '\n\n', text)
                text = '\n'.join(l.rstrip() for l in text.splitlines())

            elif rtype == "strip_html":
                text = re.sub(r'<[^>]+>', '', text)
                for entity, char in [('&amp;','&'),('&lt;','<'),('&gt;','>'),('&nbsp;',' '),('&quot;','"')]:
                    text = text.replace(entity, char)

            elif rtype == "fix_encoding":
                replacements = {
                    'â€™': "'", 'â€œ': '"', 'â€\x9d': '"', 'â€¦': '…',
                    'â€"': '—', 'â€"': '–', 'Ã©': 'é', 'Ã¨': 'è',
                    'Ã ': 'à', 'Ã®': 'î', 'Ã´': 'ô', 'Ã¹': 'ù',
                }
                for bad, good in replacements.items():
                    text = text.replace(bad, good)

            elif rtype == "remove_blank_lines":
                lines = [l for l in text.splitlines() if l.strip()]
                text = '\n'.join(lines)

            elif rtype == "remove_headers_footers":
                from collections import Counter
                lines = text.splitlines()
                counts = Counter(l.strip() for l in lines if l.strip())
                repeated = {l for l, c in counts.items() if c >= 3 and len(l) < 120}
                text = '\n'.join(l for l in lines if l.strip() not in repeated)

            elif rtype == "redact_pattern":
                pattern = params.get("pattern", "")
                replacement = params.get("replacement", "[REDACTED]")
                if pattern:
                    # ReDoS protection: validate regex compiles and cap length
                    if len(pattern) > 200:
                        print(f"[executor] redact_pattern too long ({len(pattern)} chars), skipping")
                    else:
                        try:
                            compiled = re.compile(pattern)
                            text = compiled.sub(str(replacement), text)
                        except re.error as regex_err:
                            print(f"[executor] invalid redact_pattern regex: {regex_err}")

            elif rtype == "ner_redact":
                entities   = params.get("entities", ["PERSON", "ORG", "GPE", "DATE"])
                repl_token = str(params.get("replacement", "[REDACTED]"))
                if "PERSON" in entities:
                    text = re.sub(r'\b(?:Mr|Mrs|Ms|Dr|Prof)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b', repl_token, text)
                    text = re.sub(r'\b[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}\b', repl_token, text)
                if "ORG" in entities:
                    text = re.sub(r'\b[A-Z][A-Za-z\s&,\.]{2,50}(?:Inc|LLC|Ltd|LLP|Corp|Co|Company|Group|Holdings|Technologies|Solutions|Services|Associates|Consulting|Industries|Enterprises)\.?\b', repl_token, text)
                if "GPE" in entities:
                    text = re.sub(r'\b\d{1,5}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}(?:\s+(?:St|Ave|Blvd|Rd|Dr|Ln|Way|Ct|Pl|Terrace|Circle|Drive|Street|Avenue|Road|Lane|Court|Place)\.?)?\b', repl_token, text)
                    text = re.sub(r'\b\d{5}(?:-\d{4})?\b', repl_token, text)
                if "DATE" in entities:
                    text = re.sub(r'\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b', repl_token, text)
                    text = re.sub(r'\b\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}\b', repl_token, text)
                if "IP" in entities:
                    text = re.sub(r'\b(?:\d{1,3}\.){3}\d{1,3}\b', repl_token, text)

        except Exception as e:
            print(f"[executor] skipping doc rule {rtype}: {e}")

    return text


def _parse_params_simple(raw) -> dict:
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except Exception:
            return {}
    return raw or {}


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
        df = pd.read_csv(io.BytesIO(file_bytes), sep=sep, low_memory=False)
    elif fmt == "tsv":
        df = pd.read_csv(buf, sep="\t", low_memory=False)
    elif fmt in ("json", "jsonl"):
        text = file_bytes.decode("utf-8", errors="replace").strip()
        if fmt == "jsonl":
            try:
                df = pd.read_json(io.BytesIO(file_bytes), lines=True)
                return _strip_sidecar_cols(df)
            except Exception:
                pass
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                df = pd.json_normalize(parsed)
            elif isinstance(parsed, dict):
                for v in parsed.values():
                    if isinstance(v, list):
                        df = pd.json_normalize(v)
                        return _strip_sidecar_cols(df)
                df = pd.json_normalize([parsed])
            else:
                df = pd.read_json(io.BytesIO(file_bytes), lines=True)
        except Exception:
            df = pd.read_json(io.BytesIO(file_bytes), lines=True)
    elif fmt in ("xlsx", "xls"):
        xl = pd.ExcelFile(buf)
        df = xl.parse(xl.sheet_names[0])
    elif fmt == "xml":
        from lxml import etree
        root = etree.fromstring(file_bytes)
        rows = [{child.tag: child.text for child in elem} for elem in root]
        if not rows:
            rows = [{sub.tag: sub.text for sub in root}]
        df = pd.DataFrame(rows)
    elif fmt == "parquet":
        df = pd.read_parquet(buf)
    else:
        raise ValueError(f"Unsupported format for executor: {fmt}")

    return _strip_sidecar_cols(df)


def _strip_sidecar_cols(df: pd.DataFrame) -> pd.DataFrame:
    """Remove __orig_* audit sidecar columns from re-ingested processed files."""
    sidecar_cols = [c for c in df.columns if str(c).startswith(SIDECAR_PREFIX)]
    if sidecar_cols:
        print(f"[executor] stripping {len(sidecar_cols)} __orig_* sidecar columns from re-ingested file")
        df = df.drop(columns=sidecar_cols)
    return df


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



# Tabular rule types the executor implements. Anything else is reported as skipped.
SUPPORTED_TABULAR_RULES = {
    "drop_nulls", "deduplicate", "semantic_deduplicate", "type_cast", "rename", "filter",
    "normalize", "fill_nulls", "trim_whitespace", "ffill", "bfill", "bool_cast", "outlier_cap",
    "multi_currency_strip", "filter_extended", "split_column", "column_header_normalize",
    "ner_redact",
}

# Rule types that only make sense with an existing target column.
COLUMN_REQUIRED_RULES = {
    "type_cast", "rename", "filter", "normalize", "fill_nulls", "ffill", "bfill", "bool_cast",
    "outlier_cap", "filter_extended", "split_column",
}

ROW_LOSS_GUARD = 0.20  # per-rule maximum row loss for LOSS rules

# Bad-cell guard. A row-removing rule is flagged when rows it removes are otherwise valid
# and were removed only because ONE cell holds a placeholder (below) or, in a mostly numeric
# column, a non-number. Must stay identical to PLACEHOLDER_TOKENS in src/lib/rule-guard.ts
# (test_contracts.py), which flags the same rules in the Data PR before they are approved.
PLACEHOLDER_TOKENS = frozenset({
    ".", "..", "...", "-", "--", "---", "?", "??", "???",
    "n/a", "na", "n.a.", "n.a", "#n/a", "null", "none", "nil", "nan", "missing",
    "unknown", "undefined", "not available", "not applicable", "tbd", "tbc",
    "#value!", "#ref!", "#div/0!", "#name?", "#num!", "#null!", "#error!",
})
BAD_CELL_GUARD_RULES = {"filter", "filter_extended", "drop_nulls"}


class RuleSkipped(Exception):
    """Raised inside a rule branch when the rule cannot be applied safely; the frame is restored."""


def _add_sidecar(df: pd.DataFrame, col) -> None:
    sidecar = f"{SIDECAR_PREFIX}{col}"
    if sidecar not in df.columns:
        df[sidecar] = df[col]


def _sidecar_base(name) -> str | None:
    """'__orig_price' -> 'price'; None for a column that is not a sidecar."""
    s = str(name)
    return s[len(SIDECAR_PREFIX):] if s.startswith(SIDECAR_PREFIX) else None


# A text value is "just the number" when it is a plain decimal literal: no whitespace,
# thousands separators, currency, exponent or leading zeros ("007" and "02139" are kept
# as text in the audit file because the zeros would be lost).
_PLAIN_NUMBER = re.compile(r"[+-]?(?:0|[1-9]\d*)(?:\.\d+)?")


def _is_null(v) -> bool:
    try:
        return bool(pd.isna(v))
    except (TypeError, ValueError):
        return False  # list-like cell (JSON input): never null


def _is_number(v) -> bool:
    return isinstance(v, (int, float, np.integer, np.floating)) and not isinstance(v, (bool, np.bool_))


def _value_preserved(orig, new) -> bool:
    """True when ``new`` carries all the information of ``orig`` (no audit copy needed)."""
    o_null, n_null = _is_null(orig), _is_null(new)
    if o_null or n_null:
        return o_null and n_null  # a value that appeared or disappeared is a change
    if isinstance(orig, str):
        if isinstance(new, str):
            return orig == new
        if _is_number(new):
            return _PLAIN_NUMBER.fullmatch(orig) is not None and float(orig) == float(new)
        return False
    if _is_number(orig) and _is_number(new):
        return float(orig) == float(new)
    if type(orig) is not type(new) and (isinstance(orig, (bool, np.bool_)) or isinstance(new, (bool, np.bool_))):
        return False
    try:
        return bool(orig == new)
    except Exception:
        return False


def _column_changed_lossily(orig: pd.Series, new: pd.Series) -> bool:
    if orig.equals(new):
        return False
    return not all(_value_preserved(o, n) for o, n in zip(orig.tolist(), new.tolist()))


def _matches_null_value(v, null_values: list) -> bool:
    """True when cell ``v`` equals one of ``null_values`` (text case-insensitively, numbers by value)."""
    if _is_null(v):
        return False
    text = str(v).strip().lower()
    for nv in null_values:
        if text == str(nv).strip().lower():
            return True
        try:
            if float(text) == float(nv):
                return True
        except (TypeError, ValueError):
            pass
    return False


def _drop_noop_sidecars(df: pd.DataFrame, before_cols) -> pd.DataFrame:
    """Drop __orig_* columns a rule just added when no value in the column lost information.

    Sidecars exist so the audit file can show what a lossy change replaced (a value that
    became null, "$1,200" that became 1200). A cast of "34" to 34 loses nothing, so it
    gets no copy.
    """
    noop = []
    for c in df.columns:
        base = _sidecar_base(c)
        if base is None or c in before_cols or base not in df.columns:
            continue
        if not _column_changed_lossily(df[c], df[base]):
            noop.append(c)
    return df.drop(columns=noop) if noop else df


def _row_loss_guard(before: pd.DataFrame, after: pd.DataFrame, rtype: str) -> None:
    loss_pct = 1 - len(after) / max(len(before), 1)
    if loss_pct > ROW_LOSS_GUARD:
        raise RuleSkipped(f"row-loss guard: {rtype} would remove {loss_pct:.0%} of rows (limit {ROW_LOSS_GUARD:.0%})")


def _normalize_column(df: pd.DataFrame, col, params: dict) -> None:
    """Standardize a text column: dates -> YYYY-MM-DD, other strings -> trimmed lowercase.

    Never rescales numeric columns, never turns nulls into "nan"/"none" strings, and never
    blanks values that fail to parse as dates (they keep their trimmed/lowercased form).
    """
    series = df[col]
    if not _is_text(series):
        raise RuleSkipped(f"normalize only applies to text/date columns (column dtype is {series.dtype})")

    present = series.notna()
    as_str = series[present].astype(str)
    normalized = as_str.str.strip().str.lower()

    sample = as_str.head(50)
    # Numeric-looking text ("10", "2.5") must never be reinterpreted as dates.
    looks_numeric = len(sample) > 0 and pd.to_numeric(sample.str.strip(), errors="coerce").notna().mean() > 0.5
    sample_parsed = pd.to_datetime(sample, format="mixed", dayfirst=False, errors="coerce")
    if len(sample) and not looks_numeric and sample_parsed.notna().sum() > len(sample) * 0.3:
        try:
            parsed = pd.to_datetime(as_str, format="mixed", dayfirst=False, errors="coerce")
        except Exception:
            parsed = pd.to_datetime(as_str, errors="coerce")
        retry_mask = parsed.isna()
        if retry_mask.any():
            parsed[retry_mask] = pd.to_datetime(as_str[retry_mask], format="mixed", dayfirst=True, errors="coerce")
        ok = parsed.notna()
        # Only parsed values become ISO dates; everything else keeps its normalized text.
        normalized = normalized.where(~ok, parsed.dt.strftime("%Y-%m-%d"))

    value_map = params.get("value_map") or {}
    if value_map:
        vmap = {str(k).strip().lower(): str(v) for k, v in value_map.items()}
        normalized = normalized.map(lambda v: vmap.get(v, v))

    if normalized.equals(series[present]):
        return  # nothing to change, no sidecar needed
    _add_sidecar(df, col)
    new_col = series.astype(object).copy()
    new_col[present] = normalized
    df[col] = new_col


# ── semantic_deduplicate: MinHash + LSH banding ──────────────────────────────
#
# A row is a near-duplicate when the MinHash estimate of the Jaccard similarity of its
# lowercased whitespace-token set with an earlier KEPT row is >= threshold; the first
# occurrence is kept. The old implementation compared every row with every kept row
# (O(n^2) in Python: hours for ~57k rows, so the run outlived the 15-minute Lambda timeout).
# LSH banding only verifies rows that share at least one band bucket, so the cost is
# O(n * num_perm) to build signatures plus the (small) number of candidate pairs.
#
# Hashing is deterministic: tokens are hashed with blake2b and the permutations are fixed
# universal hashes, so results no longer depend on PYTHONHASHSEED (built-in hash()).

SEMANTIC_DEDUP_MAX_ROWS = int(os.environ.get("SEMANTIC_DEDUP_MAX_ROWS", "500000"))
SEMANTIC_DEDUP_MAX_PERM = 512
# With no Lambda context (local runs, tests), cap the rule at this many seconds.
SEMANTIC_DEDUP_DEFAULT_BUDGET_S = float(os.environ.get("SEMANTIC_DEDUP_BUDGET_S", "600"))
# Time left in the invocation that the rule never uses (other rules, writing the output,
# DB updates): min(EXECUTOR_RESERVE_S, 25% of the invocation's remaining time). The rule is
# skipped, not half-applied, if it would run into it.
LAMBDA_RESERVE_S = float(os.environ.get("EXECUTOR_RESERVE_S", "120"))
_MERSENNE_61 = (1 << 61) - 1
_MASK_32 = np.uint64(0xFFFFFFFF)

_invocation_deadline: float | None = None  # time.monotonic(); set by handler(), reserve already taken off


def set_invocation_deadline(context) -> None:
    """Record when long-running rules must stop in this invocation (None without a Lambda context)."""
    global _invocation_deadline
    try:
        remaining_s = float(context.get_remaining_time_in_millis()) / 1000.0
    except Exception:
        _invocation_deadline = None
        return
    reserve = min(LAMBDA_RESERVE_S, 0.25 * remaining_s)
    _invocation_deadline = time.monotonic() + remaining_s - reserve


def _rule_deadline(budget_s: float = SEMANTIC_DEDUP_DEFAULT_BUDGET_S) -> tuple[float, str]:
    """Monotonic time by which a long-running rule must finish, and where the limit comes from."""
    now = time.monotonic()
    if _invocation_deadline is not None:
        return _invocation_deadline, "the Lambda time limit"
    return now + budget_s, f"the {budget_s:.0f}s time budget"


def _lsh_params(threshold: float, num_perm: int) -> tuple[int, int]:
    """(bands, rows_per_band) for LSH over num_perm MinHash values.

    A pair with Jaccard s becomes a candidate with probability 1 - (1 - s^r)^b. Pick the
    largest r (most selective buckets, fewest candidates) whose b = num_perm // r bands
    still make a pair AT the threshold a candidate with probability >= 99%, so LSH itself
    misses at most ~1% of pairs right at the threshold and fewer above it (MinHash
    estimation noise near the threshold is larger than that). Candidates are always
    verified against the full signature, so a smaller r only costs time, never accuracy.
    """
    t = min(max(threshold, 0.01), 0.999)
    best = (num_perm, 1)
    for r in range(1, num_perm + 1):
        b = num_perm // r
        if b < 1:
            break
        if 1 - (1 - t ** r) ** b >= 0.99:
            best = (b, r)
    return best


def _perm_coeffs(num_perm: int) -> tuple[np.ndarray, np.ndarray]:
    """Fixed (a, b) coefficients for h(x) = ((a*x + b) mod 2^61-1) mod 2^32, from blake2b."""
    a = np.empty(num_perm, dtype=np.uint64)
    b = np.empty(num_perm, dtype=np.uint64)
    for i in range(num_perm):
        d = hashlib.blake2b(f"cleanstack-minhash-{i}".encode(), digest_size=8).digest()
        a[i] = (int.from_bytes(d[:4], "little") | 1)  # odd, < 2^32
        b[i] = int.from_bytes(d[4:], "little")        # < 2^32
    return a, b


def _minhash_signatures(texts: list, num_perm: int, deadline: float, limit_desc: str) -> np.ndarray:
    """(n, num_perm) uint32 MinHash signatures of each text's lowercased token set."""
    n = len(texts)
    token_ids: dict = {}
    token_hashes: list = []
    flat: list = []
    starts = np.empty(n, dtype=np.int64)
    for i, text in enumerate(texts):
        starts[i] = len(flat)
        for tok in set(text.lower().split()) or {""}:
            tid = token_ids.get(tok)
            if tid is None:
                tid = token_ids[tok] = len(token_hashes)
                token_hashes.append(int.from_bytes(
                    hashlib.blake2b(tok.encode("utf-8", "surrogatepass"), digest_size=4).digest(), "little"))
            flat.append(tid)
    if time.monotonic() > deadline:
        raise RuleSkipped(f"semantic_deduplicate skipped: tokenizing {n:,} rows already reached {limit_desc}")

    tok_hash = np.asarray(token_hashes, dtype=np.uint64)
    flat_ids = np.asarray(flat, dtype=np.int64)
    a, b = _perm_coeffs(num_perm)
    mersenne = np.uint64(_MERSENNE_61)
    sigs = np.empty((n, num_perm), dtype=np.uint32)
    # Chunk rows so each (num_perm x tokens) uint64 intermediate stays around 16 MB.
    max_tokens = max(1, (16 << 20) // (8 * num_perm))
    row = 0
    while row < n:
        end_tok_target = starts[row] + max_tokens
        row_end = int(np.searchsorted(starts, end_tok_target, side="right"))
        row_end = min(max(row_end, row + 1), n)
        t0 = starts[row]
        t1 = starts[row_end] if row_end < n else len(flat_ids)
        x = tok_hash[flat_ids[t0:t1]]                                   # (k,)
        # a, b, x < 2^32, so a*x + b < 2^64: exact in uint64, no overflow.
        hv = ((a[:, None] * x[None, :] + b[:, None]) % mersenne) & _MASK_32  # (num_perm, k)
        sigs[row:row_end] = np.minimum.reduceat(hv, starts[row:row_end] - t0, axis=1).T
        row = row_end
        if time.monotonic() > deadline:
            raise RuleSkipped(
                f"semantic_deduplicate skipped: hashing {n:,} rows would exceed {limit_desc}")
    return sigs


def _semantic_dedup_keep(texts: list, threshold: float, num_perm: int) -> list:
    """Row positions to keep (first occurrence of each near-duplicate group), in order."""
    n = len(texts)
    if n > SEMANTIC_DEDUP_MAX_ROWS:
        raise RuleSkipped(
            f"semantic_deduplicate skipped: {n:,} rows exceeds the {SEMANTIC_DEDUP_MAX_ROWS:,}-row limit "
            "for one executor run")
    if not 0 < threshold <= 1:
        raise RuleSkipped(f"threshold must be in (0, 1], got {threshold}")
    if not 1 <= num_perm <= SEMANTIC_DEDUP_MAX_PERM:
        raise RuleSkipped(f"num_perm must be between 1 and {SEMANTIC_DEDUP_MAX_PERM}, got {num_perm}")
    if n == 0:
        return []
    deadline, limit_desc = _rule_deadline()
    if time.monotonic() >= deadline:
        raise RuleSkipped(f"semantic_deduplicate skipped: not enough time left before {limit_desc}")

    sigs = _minhash_signatures(texts, num_perm, deadline, limit_desc)
    bands, r = _lsh_params(threshold, num_perm)
    min_equal = math.ceil(threshold * num_perm - 1e-9)  # equal slots needed: estimate >= threshold

    # Bucket key for (row, band k): the band's r signature values as bytes.
    banded = np.ascontiguousarray(sigs[:, :bands * r])
    width = 4 * r  # bytes per band (uint32 values)
    buckets = [dict() for _ in range(bands)]
    keep: list = []
    for i in range(n):
        if i & 1023 == 0 and time.monotonic() > deadline:
            raise RuleSkipped(
                f"semantic_deduplicate skipped: comparing {n:,} rows would exceed {limit_desc} "
                f"(stopped after {i:,} rows; too many similar candidate rows)")
        row_bytes = banded[i].tobytes()
        keys = [row_bytes[k * width:(k + 1) * width] for k in range(bands)]
        cands: set = set()
        for k in range(bands):
            hit = buckets[k].get(keys[k])
            if hit:
                cands.update(hit)
        if cands:
            idx = np.fromiter(cands, dtype=np.int64, count=len(cands))
            equal = np.count_nonzero(sigs[idx] == sigs[i], axis=1)
            if (equal >= min_equal).any():
                continue  # near-duplicate of an earlier kept row
        keep.append(i)
        for k in range(bands):
            buckets[k].setdefault(keys[k], []).append(i)
    return keep


def _apply_rule(df: pd.DataFrame, rtype: str, col, params: dict) -> pd.DataFrame:
    """Apply one rule. Returns the new frame; raises RuleSkipped when it cannot be applied."""
    if rtype == "drop_nulls":
        before = df
        if col:
            if col not in df.columns:
                raise RuleSkipped(f"column {col!r} not found")
            # Column rule: drop rows where this column is null. ("threshold" only applies to
            # table-level rules; for a single column it has no meaningful interpretation.)
            df = df[df[col].notna()]
        else:
            threshold = params.get("threshold")
            if isinstance(threshold, (int, float)) and 0 < float(threshold) <= 1:
                min_non_null = max(1, math.ceil(float(threshold) * df.shape[1]))
                df = df.dropna(thresh=min_non_null)
            else:
                df = df.dropna()
        _row_loss_guard(before, df, rtype)
        return df

    if rtype == "deduplicate":
        subset = [col] if col and col in df.columns else None
        return df.drop_duplicates(subset=subset, keep="first")

    if rtype == "semantic_deduplicate":
        target_col = col if col and col in df.columns else None
        if target_col is None:
            text_cols = _text_cols(df)
            target_col = text_cols[0] if text_cols else None
        if not target_col:
            raise RuleSkipped("no text column to compare")
        threshold = float(params.get("threshold", 0.8))
        num_perm = int(params.get("num_perm", 64))
        keep = _semantic_dedup_keep(df[target_col].astype(str).tolist(), threshold, num_perm)
        return df.iloc[keep].reset_index(drop=True)

    if rtype == "type_cast":
        target = params.get("target_type", "str")
        null_values = params.get("null_values")
        if null_values:
            # Placeholder codes the parser would accept as numbers (99999, -9999) or text it
            # would not ("N/A") become null; the row is kept. The original goes to the sidecar.
            if not isinstance(null_values, list):
                null_values = [null_values]
            _add_sidecar(df, col)
            df[col] = df[col].where(~df[col].map(lambda v: _matches_null_value(v, null_values)), other=None)
        if target in ("float", "float64", "numeric", "number", "int", "int64", "datetime", "date", "timestamp"):
            _add_sidecar(df, col)
        if target in ("float", "float64", "numeric", "number"):
            df[col] = _to_numeric_clean(df[col])
        elif target in ("int", "int64"):
            df[col] = _to_numeric_clean(df[col]).astype("Int64")  # raises on non-integral values
        elif target == "str":
            present = df[col].notna()
            new_col = df[col].astype(object).copy()
            new_col[present] = df[col][present].astype(str)
            df[col] = new_col
        elif target in ("datetime", "date", "timestamp"):
            try:
                parsed = pd.to_datetime(df[col], format="mixed", dayfirst=False, errors="coerce")
            except Exception:
                parsed = pd.to_datetime(df[col], errors="coerce")
            df[col] = parsed.dt.strftime("%Y-%m-%d").where(parsed.notna(), other=None)
        else:
            try:
                df[col] = df[col].astype(target)
            except (TypeError, ValueError) as e:
                raise RuleSkipped(f"cannot cast to {target!r}: {e}")
        return df

    if rtype == "rename":
        new_name = params.get("new_name")
        if not new_name:
            raise RuleSkipped("missing new_name")
        mapping = {col: new_name}
        if f"{SIDECAR_PREFIX}{col}" in df.columns:
            mapping[f"{SIDECAR_PREFIX}{col}"] = f"{SIDECAR_PREFIX}{new_name}"
        return df.rename(columns=mapping)

    if rtype in ("filter", "filter_extended"):
        before = df
        operator = params.get("operator", "notnull")
        value = params.get("value")
        values = params.get("values", [])
        pattern = params.get("pattern", "")
        series = df[col]
        if operator == "notnull":
            df = df[series.notna()]
        elif operator == "eq":
            df = df[series == value]
        elif operator == "neq":
            df = df[series != value]
        elif operator in ("gt", "lt", "gte", "lte"):
            num = _to_numeric_clean(series)
            v = float(value)
            mask = {"gt": num > v, "lt": num < v, "gte": num >= v, "lte": num <= v}[operator]
            # A missing or unparseable cell ("." placeholder) is not "out of range": keep the
            # row. Only rows holding a number that fails the comparison are removed.
            df = df[mask | num.isna()]
        elif rtype == "filter_extended" and operator == "contains":
            df = df[series.astype(str).str.contains(str(value), na=False, regex=False)]
        elif rtype == "filter_extended" and operator == "not_contains":
            df = df[~series.astype(str).str.contains(str(value), na=False, regex=False)]
        elif rtype == "filter_extended" and operator == "in":
            df = df[series.isin(values)]
        elif rtype == "filter_extended" and operator == "not_in":
            df = df[~series.isin(values)]
        elif rtype == "filter_extended" and operator == "regex":
            if not pattern or len(pattern) > 200:
                raise RuleSkipped("regex pattern missing or longer than 200 characters")
            try:
                df = df[series.astype(str).str.match(pattern, na=False)]
            except re.error as e:
                raise RuleSkipped(f"invalid regex: {e}")
        elif rtype == "filter_extended" and operator == "startswith":
            df = df[series.astype(str).str.startswith(str(value), na=False)]
        elif rtype == "filter_extended" and operator == "endswith":
            df = df[series.astype(str).str.endswith(str(value), na=False)]
        else:
            raise RuleSkipped(f"unsupported operator {operator!r}")
        _row_loss_guard(before, df, rtype)
        return df

    if rtype == "normalize":
        _normalize_column(df, col, params)
        return df

    if rtype == "fill_nulls":
        strategy = params.get("strategy", "value")
        fill_value = params.get("value", "Uncategorized")
        if strategy in ("mean", "median", "mode"):
            _add_sidecar(df, col)
        if strategy == "mean":
            df[col] = df[col].fillna(_to_numeric_clean(df[col]).mean())
        elif strategy == "median":
            df[col] = df[col].fillna(_to_numeric_clean(df[col]).median())
        elif strategy == "mode":
            mode = df[col].mode()
            df[col] = df[col].fillna(mode[0] if len(mode) > 0 else fill_value)
        else:
            df[col] = df[col].fillna(fill_value)
        return df

    if rtype == "trim_whitespace":
        targets = [col] if (col and col in df.columns) else _text_cols(df)
        for c in targets:
            # Only text values are stripped. Numbers in a mixed column (Excel cells holding
            # 34 next to a "." placeholder) stay numbers instead of becoming "34".
            is_str = df[c].map(lambda v: isinstance(v, str))
            if not is_str.any():
                continue
            stripped = df[c][is_str].str.strip()
            new_col = df[c].astype(object).copy()
            new_col[is_str] = stripped.where(stripped != "", other=None)
            df[c] = new_col
        return df

    if rtype in ("ffill", "bfill"):
        _add_sidecar(df, col)
        df[col] = df[col].ffill() if rtype == "ffill" else df[col].bfill()
        return df

    if rtype == "bool_cast":
        _add_sidecar(df, col)
        true_vals = {"true", "yes", "1", "t", "y", "on"}
        false_vals = {"false", "no", "0", "f", "n", "off"}
        target = params.get("target", "bool")

        def _cast_bool(v):
            if pd.isna(v):
                return v
            s = str(v).strip().lower()
            if s in true_vals:
                return True if target == "bool" else (1 if target == "int" else "true")
            if s in false_vals:
                return False if target == "bool" else (0 if target == "int" else "false")
            return v  # unknown value -> keep original unchanged

        df[col] = df[col].astype(object).map(_cast_bool)
        return df

    if rtype == "outlier_cap":
        multiplier = float(params.get("iqr_multiplier", 1.5))
        numeric = pd.to_numeric(df[col], errors="coerce")
        if numeric.notna().sum() == 0:
            raise RuleSkipped("column has no numeric values")
        q1, q3 = numeric.quantile(0.25), numeric.quantile(0.75)
        iqr = q3 - q1
        lower, upper = q1 - multiplier * iqr, q3 + multiplier * iqr
        if params.get("min_val") is not None:
            lower = float(params["min_val"])
        if params.get("max_val") is not None:
            upper = float(params["max_val"])
        _add_sidecar(df, col)
        df[col] = numeric.clip(lower=lower, upper=upper)
        return df

    if rtype == "multi_currency_strip":
        targets = [col] if (col and col in df.columns) else _text_cols(df)
        pattern = r'[$€£¥₹₩]|(?:USD|EUR|GBP|JPY|INR|CAD|AUD|CHF)\s*'
        converted = 0
        for c in targets:
            if not _is_text(df[c]):
                continue
            cleaned = df[c].astype(str).str.replace(pattern, "", regex=True)
            cleaned = cleaned.str.replace(",", "", regex=False).str.strip()
            numeric = pd.to_numeric(cleaned, errors="coerce")
            non_null = df[c].notna().sum()
            if non_null > 0 and numeric.notna().sum() / non_null > 0.5:
                _add_sidecar(df, c)
                df[c] = numeric
                converted += 1
        if not converted:
            raise RuleSkipped("no column parsed as currency (>50% numeric after stripping symbols)")
        return df

    if rtype == "split_column":
        delimiter = params.get("delimiter", "|")
        new_col_names = params.get("new_columns", [])
        max_splits = int(params.get("max_splits", -1))
        split_df = df[col].astype(str).str.split(
            pat=re.escape(delimiter), n=max_splits if max_splits > 0 else -1, expand=True, regex=True,
        )
        for i in range(split_df.shape[1]):
            new_name = new_col_names[i] if i < len(new_col_names) else f"{col}_part{i + 1}"
            df[new_name] = split_df[i]
        return df  # source column preserved

    if rtype == "column_header_normalize":
        def _to_snake(name: str) -> str:
            s = str(name).strip()
            s = re.sub(r'[^\w\s]', '_', s)
            s = re.sub(r'\s+', '_', s)
            s = re.sub(r'([a-z])([A-Z])', r'\1_\2', s)
            s = re.sub(r'_+', '_', s)
            return s.lower().strip('_')
        # Sidecars are renamed with their column ("__orig_Acceptance Rate(%)" ->
        # "__orig_acceptance_rate"). Snake-casing the sidecar name itself would strip the
        # "__" prefix, and the copy would leak into the deliverable as "orig_<col>".
        rename_map = {}
        for c in df.columns:
            if _sidecar_base(c) is not None:
                continue
            new_name = _to_snake(str(c))
            if new_name != str(c):
                rename_map[c] = new_name
                if f"{SIDECAR_PREFIX}{c}" in df.columns:
                    rename_map[f"{SIDECAR_PREFIX}{c}"] = f"{SIDECAR_PREFIX}{new_name}"
        if rename_map:
            df = df.rename(columns=rename_map)
        return df

    if rtype == "ner_redact":
        entities = params.get("entities", ["PERSON", "ORG", "GPE", "DATE"])
        repl_token = str(params.get("replacement", "[REDACTED]"))
        targets = [col] if (col and col in df.columns) else _text_cols(df)
        patterns: list = []
        if "PERSON" in entities:
            patterns += [
                r'\b(?:Mr|Mrs|Ms|Dr|Prof)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b',
                r'\b[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}\b',
            ]
        if "ORG" in entities:
            patterns += [r'\b[A-Z][A-Za-z\s&,\.]{2,50}(?:Inc|LLC|Ltd|LLP|Corp|Co|Company|Group|Holdings|Technologies|Solutions|Services|Associates|Consulting|Industries|Enterprises)\.?\b']
        if "GPE" in entities:
            us_states = (
                "Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|"
                "Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|"
                "Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|"
                "Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|"
                "New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|"
                "Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|"
                "Virginia|Washington|West Virginia|Wisconsin|Wyoming"
            )
            patterns += [
                r'\b\d{1,5}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}(?:\s+(?:St|Ave|Blvd|Rd|Dr|Ln|Way|Ct|Pl|Terrace|Circle|Drive|Street|Avenue|Road|Lane|Court|Place)\.?)?\b',
                rf'\b(?:{us_states})\b',
                r'\b\d{5}(?:-\d{4})?\b',
            ]
        if "DATE" in entities:
            patterns += [
                r'\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b',
                r'\b\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}\b',
            ]
        if "IP" in entities:
            patterns += [r'\b(?:\d{1,3}\.){3}\d{1,3}\b']
        if not patterns:
            raise RuleSkipped("no supported entity types requested")

        def _apply_ner(text: str) -> str:
            for p in patterns:
                text = re.sub(p, repl_token, text)
            return text

        for c in targets:
            present = df[c].notna()
            redacted = df[c][present].astype(str).map(_apply_ner)
            new_col = df[c].astype(object).copy()
            new_col[present] = redacted.where(redacted != "", other=None)
            df[c] = new_col
        return df

    raise RuleSkipped(f"unsupported rule type {rtype!r}")


def _blank(v) -> bool:
    return _is_null(v) or (isinstance(v, str) and v.strip() == "")


def _is_bad_cell(v, mostly_numeric: bool) -> bool:
    """A placeholder token, or a non-number in a mostly numeric column. Blanks are not bad cells."""
    if _blank(v) or _is_number(v) or isinstance(v, (bool, np.bool_)):
        return False
    s = str(v).strip()
    if s.lower() in PLACEHOLDER_TOKENS:
        return True
    return mostly_numeric and pd.isna(_to_numeric_clean(pd.Series([s])).iloc[0])


def _mostly_numeric(values: pd.Series) -> bool:
    present = values[~values.map(_blank)]
    if len(present) < 2:
        return False
    return bool(_to_numeric_clean(present).notna().mean() >= 0.5)


def bad_cell_rows(before: pd.DataFrame, after: pd.DataFrame, rtype: str, col) -> int:
    """Rows a rule removed only because of one bad cell in ``col`` (see PLACEHOLDER_TOKENS).

    A removed row counts when its ``col`` value (or, if a cast already blanked it, the original
    kept in the sidecar) is a bad cell and the rest of the row is mostly filled in. Rows that are
    mostly empty, rows removed for a real value ("deleted", 0, out of range) and blank cells
    removed by drop_nulls do not count, so legitimate filters are never flagged.
    """
    if rtype not in BAD_CELL_GUARD_RULES or not col or col not in before.columns:
        return 0
    if not after.index.isin(before.index).all():
        return 0  # the rule rebuilt the index: not a row selection we can attribute
    removed = before.loc[~before.index.isin(after.index)]
    if removed.empty:
        return 0
    sidecar = f"{SIDECAR_PREFIX}{col}"

    def original(frame: pd.DataFrame) -> pd.Series:
        if sidecar not in frame.columns:
            return frame[col]
        return frame[col].where(~frame[col].map(_is_null), frame[sidecar])

    mostly_numeric = _mostly_numeric(original(before))
    others = [c for c in before.columns if c != col and _sidecar_base(c) is None]
    if not others:
        return 0  # a single-column file: the bad cell is the whole row
    need = max(1, (len(others) + 1) // 2)
    filled = removed[others].apply(lambda r: sum(not _blank(v) for v in r), axis=1)
    bad = original(removed).map(lambda v: _is_bad_cell(v, mostly_numeric))
    return int((bad & (filled >= need)).sum())


def apply_transforms(df: pd.DataFrame, rules: list[dict], results: list | None = None,
                     skip_bad_cell_rules: bool = False) -> pd.DataFrame:
    """Apply rules in order.

    A rule that is skipped or raises leaves the frame exactly as it was before that rule
    (no half-applied changes, no stray sidecar columns). A sidecar a rule added is dropped
    again when no value in its column lost information. When ``results`` is given, one entry
    per rule is appended: {"id", "rule_type", "column_name", "applied", "reason",
    "rows_removed"}. Only rules that select rows (drop_nulls, filter, deduplicate, ...) can
    remove rows; every removal is counted and logged, never silent.

    Each entry also has "bad_cell_rows": rows the rule removed (or, when skipped by the
    guard, would have removed) only because of one bad cell (bad_cell_rows()). With
    ``skip_bad_cell_rules`` (auto mode, where no person approved the rule) such a rule is
    skipped and the rows are kept; otherwise it is applied as approved and reported.
    """
    for rule in rules:
        rtype = rule["rule_type"]
        col = rule.get("column_name")
        params = _parse_params(rule.get("parameters"))
        snapshot = df.copy()
        before_cols = set(df.columns)
        rows_before = len(df)
        applied, reason, bad_rows = True, None, 0
        try:
            if rtype not in SUPPORTED_TABULAR_RULES:
                raise RuleSkipped(f"unsupported rule type {rtype!r}")
            if rtype in COLUMN_REQUIRED_RULES and (not col or col not in df.columns):
                raise RuleSkipped(f"column {col!r} not found")
            df = _drop_noop_sidecars(_apply_rule(df, rtype, col, params), before_cols)
            bad_rows = bad_cell_rows(snapshot, df, rtype, col)
            if bad_rows and skip_bad_cell_rules:
                raise RuleSkipped(
                    f"guard: would remove {bad_rows} row(s) only because of one bad cell in {col!r} "
                    "(a placeholder or non-number); the rows were kept. Convert that value to blank "
                    "instead (type_cast with null_values)."
                )
        except RuleSkipped as e:
            df, applied, reason = snapshot, False, str(e)
        except Exception as e:  # unexpected failure: restore and report, never silently half-apply
            df, applied, reason = snapshot, False, f"error: {type(e).__name__}: {e}"[:500]
        rows_removed = rows_before - len(df)
        if not applied:
            print(f"[executor] rule {rtype} on {col} not applied: {reason}")
        elif rows_removed:
            print(f"[executor] rule {rtype} on {col} removed {rows_removed} of {rows_before} rows")
        if applied and bad_rows:
            print(f"[executor] WARNING rule {rtype} on {col} removed {bad_rows} row(s) only because of one bad cell")
        if results is not None:
            results.append({"id": rule.get("id"), "rule_type": rtype, "column_name": col,
                            "applied": applied, "reason": reason, "rows_removed": rows_removed,
                            "bad_cell_rows": bad_rows})
    return df


def split_deliverable(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame | None]:
    """Return (deliverable without __orig_* sidecars, audit frame or None if no sidecars).

    The audit frame keeps every column, so each cleaned value sits next to its original.
    """
    sidecars = [c for c in df.columns if str(c).startswith(SIDECAR_PREFIX)]
    if not sidecars:
        return df, None
    return df.drop(columns=sidecars), df


def audit_key_for(processed_key: str) -> str:
    """'processed/{pipeline}/{run}/output.json' -> 'processed/{pipeline}/{run}/audit.csv'."""
    return processed_key.rsplit("/", 1)[0] + "/audit.csv"


def profile_output(file_bytes: bytes, fmt: str, fallback_df: pd.DataFrame) -> dict:
    """Score the written deliverable exactly as the profiler scores raw uploads (review M1).

    Re-reads the bytes with the shared loader so raw and processed scores come from the same
    representation and the same formula; a run with zero applied rules keeps its score.
    """
    try:
        return compute_quality_score(load_dataframe(file_bytes, fmt))
    except Exception as e:
        print(f"[executor] could not re-load {fmt} output for scoring ({e}); scoring the frame directly")
        return compute_quality_score(fallback_df)


def schema_hash(df: pd.DataFrame) -> tuple[str, dict]:
    col_defs = {str(col): _dtype_name(df[col]) for col in df.columns}
    h = hashlib.sha256(json.dumps(col_defs, sort_keys=True).encode()).hexdigest()
    return h, col_defs


def _maybe_auto_iterate(cur, conn, s3_client, run_id, pipeline_id, raw_s3_key, fmt,
                         processed_key, iteration, processed_score):
    """Check improvement vs parent and create next pass if warranted."""
    import uuid as _uuid
    try:
        # Fetch parent_run_id, then get its processed quality score
        cur.execute("SELECT parent_run_id FROM pipeline_runs WHERE id = %s", (run_id,))
        parent_row = cur.fetchone()
        if not parent_row or not parent_row[0]:
            return

        parent_run_id = parent_row[0]
        cur.execute(
            "SELECT quality_score FROM data_profiles WHERE run_id = %s AND stage = 'processed'",
            (parent_run_id,)
        )
        parent_score_row = cur.fetchone()
        if not parent_score_row:
            return

        parent_score = float(parent_score_row[0])
        if parent_score <= 0:
            return

        improvement_pct = (float(processed_score) - parent_score) / parent_score * 100
        print(f"[executor] Auto-iterate: improvement={improvement_pct:.1f}% (pass {iteration}→{iteration+1})")

        if improvement_pct < 5.0:
            print("[executor] Improvement < 5% — stopping auto-clean loop")
            return

        # Create next pass run
        raw_bucket = os.environ["S3_RAW_BUCKET"]
        processed_bucket = os.environ["S3_PROCESSED_BUCKET"]
        user_id = raw_s3_key.split("/")[0]
        new_run_id = str(_uuid.uuid4())
        new_raw_key = f"{user_id}/{pipeline_id}/{new_run_id}/raw.{fmt}"

        # Copy processed → new raw (triggers profiler via S3 event)
        s3_client.copy_object(
            Bucket=raw_bucket,
            CopySource={"Bucket": processed_bucket, "Key": processed_key},
            Key=new_raw_key,
        )

        cur.execute(
            """INSERT INTO pipeline_runs
               (id, pipeline_id, status, file_format, raw_s3_key, started_at,
                iteration, parent_run_id, auto_mode)
               VALUES (%s, %s, 'pending', %s, %s, now(), %s, %s, TRUE)""",
            (new_run_id, pipeline_id, fmt, new_raw_key, iteration + 1, run_id)
        )
        conn.commit()
        print(f"[executor] Auto-iterate: created pass {iteration+1} run {new_run_id}")

    except Exception as e:
        import traceback
        print(f"[executor] Auto-iterate error (non-fatal, run {run_id}): {e}")
        print(traceback.format_exc())
        # Don't raise — auto-iterate failure must not fail the current run


def _record_rule_results(cur, results: list) -> None:
    """Persist each rule's outcome to transform_rules.parameters._execution.

    Follows the existing convention of executor/committee metadata living in
    parameters (auto-validate writes _reject_reasons there), so no schema
    change is needed and the run page can show "Not applied: <reason>".
    """
    for r in results:
        if not r.get("id"):
            continue
        cur.execute(
            "UPDATE transform_rules SET parameters = COALESCE(parameters, '{}'::jsonb) || %s::jsonb WHERE id = %s",
            (json.dumps({"_execution": {"applied": r["applied"], "reason": r["reason"],
                                        "rows_removed": int(r.get("rows_removed") or 0),
                                        "bad_cell_rows": int(r.get("bad_cell_rows") or 0)}}), r["id"]),
        )



def _run_prefix(raw_s3_key: str) -> str | None:
    """'{user}/{pipeline}/{run}/raw.csv' -> '{user}/{pipeline}/{run}/'. None if the key is not run-scoped."""
    parts = raw_s3_key.split("/")
    if len(parts) < 4 or not all(parts[:3]):
        return None
    return "/".join(parts[:3]) + "/"


def delete_raw_run_objects(s3_client, bucket: str, raw_s3_key: str) -> dict:
    """Delete everything under the run's raw prefix: the upload AND extracted_text.txt (review H5).

    Lists and deletes every object version and delete marker, so nothing stays recoverable on a
    versioned bucket. Falls back to deleting the current version of the two known keys when the
    role may not list/delete versions. Never raises: cleanup must not fail a completed run.
    """
    prefix = _run_prefix(raw_s3_key)
    known_keys = [raw_s3_key] + ([prefix + "extracted_text.txt"] if prefix else [])
    try:
        if not prefix:
            raise ValueError(f"refusing to purge non run-scoped key {raw_s3_key!r}")
        objects = []
        paginator = s3_client.get_paginator("list_object_versions")
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            for item in page.get("Versions", []) + page.get("DeleteMarkers", []):
                objects.append({"Key": item["Key"], "VersionId": item["VersionId"]})
        for i in range(0, len(objects), 1000):
            s3_client.delete_objects(Bucket=bucket, Delete={"Objects": objects[i:i + 1000], "Quiet": True})
        print(f"[executor] purged {len(objects)} object versions under s3://{bucket}/{prefix}")
        return {"mode": "all_versions", "deleted": len(objects)}
    except Exception as e:
        print(f"[executor] version purge failed ({e}); deleting current versions of known keys")
        deleted = 0
        for key in known_keys:
            try:
                s3_client.delete_object(Bucket=bucket, Key=key)
                deleted += 1
            except Exception as del_err:
                print(f"[executor] delete of s3://{bucket}/{key} failed (non-fatal): {del_err}")
        return {"mode": "current_only", "deleted": deleted}


# A 'running' run whose last update is older than this is an abandoned lease (Lambda's hard
# limit is 15 minutes, so the invocation that claimed it is gone) and may be re-claimed.
STALE_RUNNING_MINUTES = 15

# Conditional transition: of N deliveries of the same message only one gets a row back (review H4).
CLAIM_SQL = f"""UPDATE pipeline_runs SET status = 'running', updated_at = now()
               WHERE id = %s
                 AND (status = 'queued'
                      OR (status = 'running' AND updated_at < now() - interval '{STALE_RUNNING_MINUTES} minutes'))
               RETURNING id"""


def _publish_drift(cur, conn, pipeline_id: str, run_id: str, df: pd.DataFrame) -> None:
    """Snapshot the deliverable's schema and publish to SNS when it changed since the last run."""
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


def process_run(run_id: str, receive_count: int = 1) -> dict:
    """Execute one run.

    Idempotent: a duplicate or late message for a run that is not 'queued' (or an abandoned
    'running' lease) is a no-op, so SQS at-least-once delivery can no longer flip a completed run
    to 'failed'. A failure before completion releases the claim and raises so SQS retries, up to
    EXECUTOR_MAX_ATTEMPTS deliveries; the last attempt marks the run failed and returns.
    """
    max_attempts = int(os.environ.get("EXECUTOR_MAX_ATTEMPTS", "3"))
    conn = get_db_conn()
    cur = conn.cursor()
    completed = False
    try:
        cur.execute(CLAIM_SQL, (run_id,))
        claimed = cur.fetchone()
        conn.commit()
        if not claimed:
            print(f"[executor] run {run_id} is not queued (already processed or in progress) — skipping duplicate message")
            return {"statusCode": 200, "run_id": run_id, "skipped": True}

        # Fetch run metadata + pipeline settings
        cur.execute(
            """SELECT pr.pipeline_id, pr.raw_s3_key, pr.file_format, pr.mode,
                      pr.iteration, pr.parent_run_id, pr.auto_mode, pr.row_count_raw,
                      p.auto_delete_raw
               FROM pipeline_runs pr
               JOIN pipelines p ON pr.pipeline_id = p.id
               WHERE pr.id = %s""",
            (run_id,)
        )
        row = cur.fetchone()
        pipeline_id, raw_s3_key, file_format, run_mode, iteration, parent_run_id, auto_mode, row_count_raw, auto_delete_raw = row
        run_mode = run_mode or "tabular"
        iteration = iteration or 1
        auto_mode = auto_mode or False
        auto_delete_raw = auto_delete_raw if auto_delete_raw is not None else True

        # Fetch approved rules ordered by index
        cur.execute(
            """SELECT id, rule_type, column_name, parameters
               FROM transform_rules
               WHERE run_id = %s AND status = 'approved'
               ORDER BY order_index ASC""",
            (run_id,)
        )
        all_rules = [
            {"id": str(r[0]), "rule_type": r[1], "column_name": r[2], "parameters": r[3]}
            for r in cur.fetchall()
        ]

        # Deduplicate document rules by rule_type (S3 at-least-once can produce duplicates).
        # For tabular rules, dedup by (rule_type, column_name) to keep per-column rules.
        seen_doc: set[str] = set()
        rules = []
        for r in all_rules:
            key = r["rule_type"] if r["column_name"] is None else f"{r['rule_type']}::{r['column_name']}"
            if key not in seen_doc:
                seen_doc.add(key)
                rules.append(r)

        # column_header_normalize must run last — renames columns, invalidating all subsequent column_name lookups
        rules.sort(key=lambda r: 1 if r["rule_type"] == "column_header_normalize" else 0)

        # Read raw file from S3
        raw_bucket = os.environ["S3_RAW_BUCKET"]
        obj = s3.get_object(Bucket=raw_bucket, Key=raw_s3_key)
        file_bytes = obj["Body"].read()
        fmt = file_format or raw_s3_key.rsplit(".", 1)[-1].lower()

        processed_bucket = os.environ["S3_PROCESSED_BUCKET"]
        rule_results: list = []

        if run_mode == "document":
            text_key = "/".join(raw_s3_key.rsplit("/", 1)[:-1]) + "/extracted_text.txt"

            if fmt == "pdf":
                out_bytes, content_type, ext = apply_transforms_pdf(file_bytes, rules)
            elif fmt == "docx":
                out_bytes, content_type, ext = apply_transforms_docx(file_bytes, rules)
            else:
                # txt and other text formats — use pre-extracted text
                try:
                    text_obj = s3.get_object(Bucket=raw_bucket, Key=text_key)
                    text = text_obj["Body"].read().decode("utf-8")
                except Exception:
                    text = extract_text(file_bytes, fmt)
                text = apply_document_transforms(text, rules)
                out_bytes = text.encode("utf-8")
                content_type = "text/plain"
                ext = "txt"

            processed_key = f"processed/{pipeline_id}/{run_id}/output.{ext}"
            s3.put_object(Bucket=processed_bucket, Key=processed_key,
                          Body=out_bytes, ContentType=content_type)

            # Line count from extracted text for all doc formats
            try:
                text_obj = s3.get_object(Bucket=raw_bucket, Key=text_key)
                line_count = len(text_obj["Body"].read().decode("utf-8").splitlines())
            except Exception:
                line_count = len(out_bytes.decode("utf-8", errors="replace").splitlines())

            profile = {
                "quality_score": 95,
                "total_rows": line_count,
                "null_percentage": 0.0,
                "duplicate_percentage": 0.0,
                "type_mismatch_count": 0,
                "outlier_count": 0,
                "column_stats": {},
            }
        else:
            df = load_raw_dataframe(file_bytes, fmt)
            input_row_count = len(df)
            # Auto mode: nobody approved the rules, so a rule that would drop rows only
            # because of one bad cell is skipped (bad_cell_rows()).
            df = apply_transforms(df, rules, rule_results, skip_bad_cell_rules=auto_mode)

            # Row count guard for auto-mode passes 2+ — abort if >10% rows deleted
            if auto_mode and iteration > 1 and row_count_raw:
                output_row_count = len(df)
                loss_pct = (input_row_count - output_row_count) / max(input_row_count, 1)
                if loss_pct > 0.10:
                    print(f"[executor] Row count guard triggered: {loss_pct:.1%} loss — aborting, keeping parent output")
                    cur.execute(
                        "UPDATE pipeline_runs SET status = 'failed', error_message = %s, updated_at = now() WHERE id = %s",
                        (f"Auto-clean aborted: {loss_pct:.1%} row loss exceeds 10% safety threshold", run_id),
                    )
                    conn.commit()
                    return {"statusCode": 200, "run_id": run_id, "aborted": True}

            # The deliverable never contains __orig_* sidecars; they go to a separate
            # audit file next to it, so downloads can be served byte-for-byte from S3.
            deliverable, audit = split_deliverable(df)
            out_bytes, content_type, ext = save_dataframe(deliverable, fmt)
            processed_key = f"processed/{pipeline_id}/{run_id}/output.{ext}"
            s3.put_object(Bucket=processed_bucket, Key=processed_key, Body=out_bytes, ContentType=content_type)
            if audit is not None:
                audit_bytes, _, _ = save_dataframe(audit, "csv")
                s3.put_object(Bucket=processed_bucket, Key=audit_key_for(processed_key),
                              Body=audit_bytes, ContentType="text/csv")
            df = deliverable
            profile = profile_output(out_bytes, ext, deliverable)

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
                json.dumps(_sanitize_nan(profile["column_stats"]), cls=_NpEncoder),
            ),
        )
        _record_rule_results(cur, rule_results)

        cur.execute(
            """UPDATE pipeline_runs
               SET status = 'completed',
                   processed_s3_key = %s,
                   row_count_processed = %s,
                   error_message = NULL,
                   completed_at = now(),
                   updated_at = now()
               WHERE id = %s""",
            (processed_key, profile["total_rows"], run_id),
        )
        conn.commit()
        completed = True

        # ---- Post-completion steps: each is best effort and must never flip a completed run ----
        if run_mode != "document":
            try:
                _publish_drift(cur, conn, pipeline_id, run_id, df)
            except Exception as drift_err:
                conn.rollback()
                print(f"[executor] drift snapshot failed for run {run_id} (run stays completed): {drift_err}")

        # Auto-iterate copies the processed output into a new run prefix, so it is independent
        # of the raw cleanup below. _maybe_auto_iterate already swallows its own errors.
        if auto_mode and iteration < 3:
            _maybe_auto_iterate(
                cur, conn, s3, run_id, pipeline_id, raw_s3_key, fmt,
                processed_key, iteration, profile["quality_score"]
            )

        # Privacy: remove the raw upload AND the extracted document text (all versions).
        if auto_delete_raw:
            delete_raw_run_objects(s3, raw_bucket, raw_s3_key)

        return {"statusCode": 200, "run_id": run_id}

    except Exception as e:
        conn.rollback()
        if completed:
            print(f"[executor] post-completion step failed for run {run_id} (run stays completed): {e}")
            return {"statusCode": 200, "run_id": run_id, "post_completion_error": str(e)[:500]}
        if receive_count < max_attempts:
            # Release the claim so the SQS redelivery can retry this run.
            cur.execute(
                "UPDATE pipeline_runs SET status = 'queued', error_message = %s, updated_at = now() WHERE id = %s",
                (f"Attempt {receive_count}/{max_attempts} failed, retrying: {e}"[:1000], run_id),
            )
            conn.commit()
            raise
        cur.execute(
            "UPDATE pipeline_runs SET status = 'failed', error_message = %s, updated_at = now() WHERE id = %s",
            (str(e)[:1000], run_id),
        )
        conn.commit()
        return {"statusCode": 200, "run_id": run_id, "failed": True}
    finally:
        cur.close()
        conn.close()


def handler(event, context):
    """SQS entrypoint. Processes every record in the batch (review M5: only Records[0] was read).

    If any record needs a retry the invocation raises, so SQS redelivers the batch; records that
    already finished are skipped on redelivery by the conditional claim.
    """
    set_invocation_deadline(context)
    retry_errors = []
    results = []
    for record in event.get("Records", []):
        run_id = json.loads(record["body"])["run_id"]
        receive_count = int((record.get("attributes") or {}).get("ApproximateReceiveCount", "1"))
        try:
            results.append(process_run(run_id, receive_count))
        except Exception as e:
            retry_errors.append(f"{run_id}: {e}")
    if retry_errors:
        raise RuntimeError("executor will retry: " + "; ".join(retry_errors))
    return results[0] if len(results) == 1 else {"statusCode": 200, "results": results}
