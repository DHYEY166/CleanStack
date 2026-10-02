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
import boto3
import psycopg2
import pandas as pd
import numpy as np

DOCUMENT_EXTENSIONS = {"pdf", "docx"}

# Audit columns holding pre-clean values. They live only in audit.csv, never in the deliverable.
SIDECAR_PREFIX = "__orig_"

def _is_text(series: pd.Series) -> bool:
    """True for string-like columns under both pandas 2 (object) and pandas 3 (str dtype)."""
    return series.dtype == object or isinstance(series.dtype, pd.StringDtype)


def _text_cols(df: pd.DataFrame) -> list:
    """All string-like columns (pandas 2 object and pandas 3 str dtypes)."""
    return [c for c in df.columns if _is_text(df[c])]


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


class RuleSkipped(Exception):
    """Raised inside a rule branch when the rule cannot be applied safely; the frame is restored."""


def _add_sidecar(df: pd.DataFrame, col) -> None:
    sidecar = f"{SIDECAR_PREFIX}{col}"
    if sidecar not in df.columns:
        df[sidecar] = df[col]


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

        def _minhash_sig(text: str, n: int) -> list:
            tokens = set(text.lower().split()) or {""}
            return [min((hash((seed, t)) & 0x7FFFFFFF) for t in tokens) for seed in range(n)]

        texts = df[target_col].astype(str).tolist()
        sigs = [_minhash_sig(t, num_perm) for t in texts]
        keep, kept_sigs = [], []
        for i, sig in enumerate(sigs):
            is_dup = any(sum(a == b for a, b in zip(sig, ks)) / num_perm >= threshold for ks in kept_sigs)
            if not is_dup:
                keep.append(i)
                kept_sigs.append(sig)
        return df.iloc[keep].reset_index(drop=True)

    if rtype == "type_cast":
        target = params.get("target_type", "str")
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
        return df.rename(columns={col: new_name})

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
            df = df[mask]
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
            present = df[c].notna()
            stripped = df[c][present].astype(str).str.strip()
            new_col = df[c].astype(object).copy()
            new_col[present] = stripped.where(stripped != "", other=None)
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
        rename_map = {c: _to_snake(str(c)) for c in df.columns if _to_snake(str(c)) != str(c)}
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


def apply_transforms(df: pd.DataFrame, rules: list[dict], results: list | None = None) -> pd.DataFrame:
    """Apply rules in order.

    A rule that is skipped or raises leaves the frame exactly as it was before that rule
    (no half-applied changes, no stray sidecar columns). When ``results`` is given, one entry
    per rule is appended: {"id", "rule_type", "column_name", "applied", "reason"}.
    """
    for rule in rules:
        rtype = rule["rule_type"]
        col = rule.get("column_name")
        params = _parse_params(rule.get("parameters"))
        snapshot = df.copy()
        applied, reason = True, None
        try:
            if rtype not in SUPPORTED_TABULAR_RULES:
                raise RuleSkipped(f"unsupported rule type {rtype!r}")
            if rtype in COLUMN_REQUIRED_RULES and (not col or col not in df.columns):
                raise RuleSkipped(f"column {col!r} not found")
            df = _apply_rule(df, rtype, col, params)
        except RuleSkipped as e:
            df, applied, reason = snapshot, False, str(e)
        except Exception as e:  # unexpected failure: restore and report, never silently half-apply
            df, applied, reason = snapshot, False, f"error: {type(e).__name__}: {e}"[:500]
        if not applied:
            print(f"[executor] rule {rtype} on {col} not applied: {reason}")
        if results is not None:
            results.append({"id": rule.get("id"), "rule_type": rtype, "column_name": col,
                            "applied": applied, "reason": reason})
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
            (json.dumps({"_execution": {"applied": r["applied"], "reason": r["reason"]}}), r["id"]),
        )


def handler(event, context):
    record = event["Records"][0]
    body = json.loads(record["body"])
    run_id = body["run_id"]

    conn = get_db_conn()
    cur = conn.cursor()

    try:
        cur.execute(
            "UPDATE pipeline_runs SET status = 'running', updated_at = now() WHERE id = %s",
            (run_id,)
        )
        conn.commit()

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
            df = apply_transforms(df, rules, rule_results)

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
            profile = compute_quality_profile(df)

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
                   completed_at = now(),
                   updated_at = now()
               WHERE id = %s""",
            (processed_key, profile["total_rows"], run_id),
        )
        conn.commit()

        # Schema drift detection — tabular only
        if run_mode == "document":
            # Auto-iterate for document mode — copy raw file BEFORE deleting it
            if auto_mode and iteration < 3:
                _maybe_auto_iterate(
                    cur, conn, s3, run_id, pipeline_id, raw_s3_key, fmt,
                    processed_key, iteration, profile["quality_score"]
                )
            # Delete raw file AFTER auto-iterate has copied it (if applicable)
            if auto_delete_raw:
                try:
                    raw_bucket = os.environ["S3_RAW_BUCKET"]
                    s3.delete_object(Bucket=raw_bucket, Key=raw_s3_key)
                    print(f"[executor] deleted raw file s3://{raw_bucket}/{raw_s3_key}")
                except Exception as del_err:
                    print(f"[executor] raw file deletion failed (non-fatal): {del_err}")
            return {"statusCode": 200, "run_id": run_id}

        # Strip __orig_* sidecar columns before schema hash — sidecars must not trigger drift alerts
        new_hash, col_defs = schema_hash(df)  # df is the sidecar-free deliverable

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

        # Auto-iterate for tabular mode — copy raw file BEFORE deleting it
        if auto_mode and iteration < 3:
            _maybe_auto_iterate(
                cur, conn, s3, run_id, pipeline_id, raw_s3_key, fmt,
                processed_key, iteration, profile["quality_score"]
            )

        # Delete raw file AFTER auto-iterate has copied it (if applicable)
        if auto_delete_raw:
            try:
                raw_bucket = os.environ["S3_RAW_BUCKET"]
                s3.delete_object(Bucket=raw_bucket, Key=raw_s3_key)
                print(f"[executor] deleted raw file s3://{raw_bucket}/{raw_s3_key}")
            except Exception as del_err:
                print(f"[executor] raw file deletion failed (non-fatal): {del_err}")

    except Exception as e:
        conn.rollback()
        cur.execute(
            "UPDATE pipeline_runs SET status = 'failed', error_message = %s, updated_at = now() WHERE id = %s",
            (str(e), run_id),
        )
        conn.commit()
        raise
    finally:
        cur.close()
        conn.close()

    return {"statusCode": 200, "run_id": run_id}
