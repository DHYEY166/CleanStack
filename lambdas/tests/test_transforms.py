"""Unit tests for executor tabular transforms (apply_transforms and helpers).

The tests in this module encode the contract from the code review (H3, M2, M3):
written first against the original executor, where they fail.
"""
import numpy as np
import pandas as pd
import pytest

from conftest import rule


# ---------------------------------------------------------------- normalize (H3)
def test_normalize_never_rescales_numeric_columns(executor):
    df = pd.DataFrame({"price": [10.0, 20.0, 30.0, 1000.0]})
    out = executor.apply_transforms(df.copy(), [rule("normalize", "price")])
    assert out["price"].tolist() == [10.0, 20.0, 30.0, 1000.0]
    assert "__orig_price" not in out.columns


def test_normalize_preserves_nulls(executor):
    df = pd.DataFrame({"status": ["Active", None, " SHIPPED ", np.nan]})
    out = executor.apply_transforms(df.copy(), [rule("normalize", "status")])
    assert out["status"].tolist()[0] == "active"
    assert out["status"].tolist()[2] == "shipped"
    assert out["status"].isna().tolist() == [False, True, False, True]


def test_normalize_dates_keeps_unparseable_values_and_writes_sidecar(executor):
    vals = ["2024-01-05", "01/07/2024", "Jan 9 2024", "pending", "call back", "2024-02-01", "TBD"]
    out = executor.apply_transforms(pd.DataFrame({"when": vals}), [rule("normalize", "when")])
    got = out["when"].tolist()
    assert got[:3] == ["2024-01-05", "2024-01-07", "2024-01-09"]
    assert got[5] == "2024-02-01"
    assert got[3] == "pending" and got[4] == "call back" and got[6] == "tbd"
    assert out["__orig_when"].tolist() == vals


# ---------------------------------------------------------------- drop_nulls (M2)
def test_drop_nulls_column_rule_with_threshold_drops_null_rows(executor):
    """threshold=0.5 is the exact schema the suggest-transforms prompt documents."""
    df = pd.DataFrame({"id": range(10), "email": ["a@x"] * 9 + [None]})
    out = executor.apply_transforms(df.copy(), [rule("drop_nulls", "email", threshold=0.5)])
    assert len(out) == 9 and out["email"].notna().all()


# ---------------------------------------------------------------- silent failures (M3)
def test_failed_rule_leaves_no_half_applied_sidecar(executor):
    df = pd.DataFrame({"qty": ["1", "2.5", "3"]})
    out = executor.apply_transforms(df.copy(), [rule("type_cast", "qty", target_type="int")])
    assert list(out.columns) == ["qty"]
    assert out["qty"].tolist() == ["1", "2.5", "3"]


# ================================================================ results API (M3)
def run(executor, df, rules):
    results = []
    out = executor.apply_transforms(df.copy(), rules, results)
    return out, results


# ---------------------------------------------------------------- normalize
def test_normalize_on_numeric_column_is_reported_as_not_applied(executor):
    _, res = run(executor, pd.DataFrame({"price": [1.0, 2.0]}), [rule("normalize", "price")])
    assert res[0]["applied"] is False and "text/date" in res[0]["reason"]


def test_normalize_does_not_turn_numeric_text_into_dates(executor):
    df = pd.DataFrame({"code": ["10", "20", "30", "x"]})
    out, _ = run(executor, df, [rule("normalize", "code")])
    assert out["code"].tolist() == ["10", "20", "30", "x"]


def test_normalize_value_map(executor):
    df = pd.DataFrame({"gender": ["M", "f", "F", None, "nb"]})
    out, _ = run(executor, df, [rule("normalize", "gender", value_map={"m": "male", "f": "female", "nb": "non-binary"})])
    assert out["gender"].tolist()[:3] == ["male", "female", "female"]
    assert pd.isna(out["gender"].tolist()[3])
    assert out["gender"].tolist()[4] == "non-binary"


# ---------------------------------------------------------------- drop_nulls
def test_drop_nulls_column_rule_drops_null_rows(executor):
    df = pd.DataFrame({"id": range(10), "email": ["a@x"] * 9 + [None]})
    out, res = run(executor, df, [rule("drop_nulls", "email", threshold=0.5)])
    assert len(out) == 9 and out["email"].notna().all()
    assert res[0]["applied"] is True


def test_drop_nulls_row_level_threshold(executor):
    df = pd.DataFrame({"a": [1, None, None, 4, 5, 6, 7, 8, 9, 10],
                       "b": [1, None, 3, 4, 5, 6, 7, 8, 9, 10],
                       "c": [1, None, 3, 4, 5, 6, 7, 8, 9, 10]})
    out, _ = run(executor, df, [rule("drop_nulls", None, threshold=0.5)])
    # row 1 is all-null (dropped); row 2 has 2/3 non-null (kept)
    assert len(out) == 9 and 1 not in out.index and 2 in out.index


def test_drop_nulls_row_loss_guard_reports_skip_and_restores(executor):
    df = pd.DataFrame({"id": range(10), "email": [None] * 5 + ["a"] * 5})
    out, res = run(executor, df, [rule("drop_nulls", "email")])
    assert len(out) == 10
    assert res[0]["applied"] is False and "row-loss guard" in res[0]["reason"]


# ---------------------------------------------------------------- silent failures
def test_failed_rule_is_reported_and_frame_restored(executor):
    df = pd.DataFrame({"qty": ["1", "2.5", "3"]})
    out, res = run(executor, df, [rule("type_cast", "qty", rule_id="r1", target_type="int")])
    assert list(out.columns) == ["qty"]  # no stray sidecar from the half-applied rule
    assert out["qty"].tolist() == ["1", "2.5", "3"]
    assert res == [{"id": "r1", "rule_type": "type_cast", "column_name": "qty",
                    "applied": False, "reason": res[0]["reason"], "rows_removed": 0,
                    "bad_cell_rows": 0}]
    assert res[0]["reason"].startswith("error:")


def test_missing_column_and_unknown_rule_are_reported(executor):
    df = pd.DataFrame({"a": [1, 2]})
    out, res = run(executor, df, [rule("fill_nulls", "nope", strategy="value", value=0), rule("parquet_write")])
    assert out.equals(df)
    assert [r["applied"] for r in res] == [False, False]
    assert "not found" in res[0]["reason"] and "unsupported rule type" in res[1]["reason"]


def test_filter_guard_and_success(executor):
    df = pd.DataFrame({"rating": ["5", "4", "-1", "3", "5", "4", "2", "1", "5", "3"]})
    out, res = run(executor, df, [rule("filter", "rating", operator="gt", value="0")])
    assert len(out) == 9 and res[0]["applied"]
    out2, res2 = run(executor, df, [rule("filter", "rating", operator="gt", value="4")])
    assert len(out2) == 10 and not res2[0]["applied"]


def test_filter_extended_regex_length_cap(executor):
    df = pd.DataFrame({"c": ["AA", "BB"]})
    _, res = run(executor, df, [rule("filter_extended", "c", operator="regex", pattern="A" * 201)])
    assert not res[0]["applied"] and "200" in res[0]["reason"]


# ---------------------------------------------------------------- other transforms
def test_type_cast_float_with_sidecar(executor):
    df = pd.DataFrame({"amount": ["$1,000", "$20", None]})
    out, res = run(executor, df, [rule("type_cast", "amount", target_type="float")])
    assert out["amount"].tolist()[:2] == [1000.0, 20.0] and pd.isna(out["amount"].tolist()[2])
    assert out["__orig_amount"].tolist()[:2] == ["$1,000", "$20"]
    assert res[0]["applied"]


def test_type_cast_str_preserves_nulls(executor):
    df = pd.DataFrame({"x": [1, None, 3]})
    out, _ = run(executor, df, [rule("type_cast", "x", target_type="str")])
    assert out["x"].tolist()[0] == "1.0" and pd.isna(out["x"].tolist()[1])


def test_trim_whitespace_preserves_nulls_and_blanks_become_null(executor):
    df = pd.DataFrame({"name": [" Alice ", None, "   ", "Bob"], "n": [1, 2, 3, 4]})
    out, _ = run(executor, df, [rule("trim_whitespace")])
    assert out["name"].tolist()[0] == "Alice" and out["name"].tolist()[3] == "Bob"
    assert out["name"].isna().tolist() == [False, True, True, False]
    assert out["n"].tolist() == [1, 2, 3, 4]


def test_fill_nulls_mean_writes_sidecar(executor):
    df = pd.DataFrame({"t": [1.0, None, 3.0]})
    out, _ = run(executor, df, [rule("fill_nulls", "t", strategy="mean")])
    assert out["t"].tolist() == [1.0, 2.0, 3.0]
    assert out["__orig_t"].isna().tolist() == [False, True, False]


def test_bool_cast_and_outlier_cap(executor):
    df = pd.DataFrame({"flag": ["Yes", "no", "maybe", None], "age": [20, 30, 40, 500]})
    out, res = run(executor, df, [rule("bool_cast", "flag"), rule("outlier_cap", "age", min_val=0, max_val=120)])
    assert out["flag"].tolist()[:3] == [True, False, "maybe"]
    assert out["age"].tolist() == [20, 30, 40, 120]
    assert all(r["applied"] for r in res)


def test_multi_currency_strip_reports_skip_when_nothing_parses(executor):
    df = pd.DataFrame({"name": ["a", "b"]})
    _, res = run(executor, df, [rule("multi_currency_strip")])
    assert not res[0]["applied"]


def test_split_column_and_header_normalize(executor):
    df = pd.DataFrame({"Full Name": ["a|b", "c|d"]})
    out, _ = run(executor, df, [rule("split_column", "Full Name", delimiter="|", new_columns=["first", "last"]),
                                rule("column_header_normalize")])
    assert list(out.columns) == ["full_name", "first", "last"]


def test_ner_redact_preserves_nulls(executor):
    df = pd.DataFrame({"note": ["call John Smith at 10.0.0.1", None]})
    out, _ = run(executor, df, [rule("ner_redact", "note", entities=["PERSON", "IP"])])
    assert out["note"].tolist()[0] == "call [REDACTED] at [REDACTED]"
    assert pd.isna(out["note"].tolist()[1])


def test_deduplicate(executor):
    df = pd.DataFrame({"a": [1, 1, 2]})
    out, _ = run(executor, df, [rule("deduplicate")])
    assert len(out) == 2


