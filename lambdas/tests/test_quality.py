"""Raw (profiler) and processed (executor) quality scores must be computed identically."""
import io
import pathlib

import pandas as pd
import pytest

LAMBDAS = pathlib.Path(__file__).resolve().parents[1]
BEGIN, END = "# === BEGIN SHARED QUALITY BLOCK ===", "# === END SHARED QUALITY BLOCK ==="


def _block(path):
    src = (LAMBDAS / path).read_text()
    return src[src.index(BEGIN):src.index(END)]


def test_shared_quality_block_is_identical():
    assert _block("profiler/handler.py") == _block("executor/handler.py"), (
        "The shared quality block in executor/handler.py has drifted from profiler/handler.py; "
        "copy the profiler block over verbatim.")


CSV = (b"name,city,score\n Alice ,NYC,10\nBob,n/a,20\nCarol, LA ,\nDan,unknown,40\n"
       b"Eve,-,50\nFrank,SF,60\n")


def _xlsx_bytes():
    buf = io.BytesIO()
    pd.DataFrame({"id": [1, 2, 3, 4], "email": ["a@x", None, "c@x", "d@x"], "amt": [1.5, 2.0, None, 9.0]}).to_excel(buf, index=False)
    return buf.getvalue()


@pytest.mark.parametrize("fmt,raw", [
    ("csv", CSV),
    ("tsv", CSV.replace(b",", b"\t")),
    ("json", b'[{"a": 1, "b": "x"}, {"a": null, "b": "N/A"}, {"a": 3, "b": " y "}]'),
    ("jsonl", b'{"a": 1, "b": "x"}\n{"a": null, "b": "N/A"}\n{"a": 3, "b": " y "}\n'),
    ("xlsx", None),
])
def test_zero_applied_rules_does_not_change_score(executor, profiler, fmt, raw):
    raw = raw if raw is not None else _xlsx_bytes()
    raw_profile = profiler.compute_quality_score(profiler.load_dataframe(raw, fmt))

    df = executor.load_raw_dataframe(raw, fmt)
    df = executor.apply_transforms(df, [])
    deliverable, _ = executor.split_deliverable(df)
    out_bytes, _, ext = executor.save_dataframe(deliverable, fmt)
    processed = executor.profile_output(out_bytes, ext, deliverable)

    assert processed["quality_score"] == raw_profile["quality_score"]
    assert processed["total_rows"] == raw_profile["total_rows"]


def test_skipped_rules_do_not_change_score(executor, profiler):
    raw_profile = profiler.compute_quality_score(profiler.load_dataframe(CSV, "csv"))
    df = executor.load_raw_dataframe(CSV, "csv")
    from conftest import rule
    df = executor.apply_transforms(df, [rule("parquet_write"), rule("normalize", "score")])
    out_bytes, _, ext = executor.save_dataframe(df, "csv")
    assert executor.profile_output(out_bytes, ext, df)["quality_score"] == raw_profile["quality_score"]


def test_cleaning_improves_score(executor, profiler):
    raw_profile = profiler.compute_quality_score(profiler.load_dataframe(CSV, "csv"))
    from conftest import rule
    df = executor.apply_transforms(executor.load_raw_dataframe(CSV, "csv"), [rule("trim_whitespace")])
    out_bytes, _, ext = executor.save_dataframe(df, "csv")
    assert executor.profile_output(out_bytes, ext, df)["quality_score"] > raw_profile["quality_score"]


def test_profiler_scores_csv(profiler):
    """Regression: on pandas 3 the profiler crashed in Series.quantile for text columns."""
    p = profiler.compute_quality_score(profiler.load_dataframe(CSV, "csv"))
    assert 0 <= p["quality_score"] <= 100
    assert p["column_stats"]["name"]["type"] == "object"
    assert p["column_stats"]["city"]["sentinel_count"] == 3


def test_profiler_signals_on_text_columns(profiler):
    df = profiler.load_dataframe(b"flag,amt,Messy Col\nyes,$1,a\nno,\xe2\x82\xac2,b\nyes,$3,c\n", "csv")
    stats = profiler.compute_quality_score(df)["column_stats"]
    sig = profiler.detect_signals(df, stats)
    assert sig["boolean_cols"] == ["flag"]
    assert sig["currency_cols"] == ["amt"]
    assert sig["has_messy_headers"]


def test_profiler_detects_pipe_delimited_column(profiler):
    """Regression: re.escape() combined with regex=False made '|' etc. never match."""
    df = profiler.load_dataframe(b"id,parts\n1,a|b\n2,c|d\n3,e|f\n", "csv")
    sig = profiler.detect_signals(df, profiler.compute_quality_score(df)["column_stats"])
    assert sig["split_cols"] == ["parts"] and sig["split_delimiters"] == {"parts": "|"}
