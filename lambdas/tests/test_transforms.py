"""Unit tests for executor tabular transforms (apply_transforms and helpers).

The tests in this module encode the contract from the code review (H3, M2, M3):
written first against the original executor, where they fail.
"""
import numpy as np
import pandas as pd
import pytest

from conftest import rule

REVIEW_RED = pytest.mark.xfail(strict=True, reason="review finding not fixed yet (red test)")


# ---------------------------------------------------------------- normalize (H3)
@REVIEW_RED
def test_normalize_never_rescales_numeric_columns(executor):
    df = pd.DataFrame({"price": [10.0, 20.0, 30.0, 1000.0]})
    out = executor.apply_transforms(df.copy(), [rule("normalize", "price")])
    assert out["price"].tolist() == [10.0, 20.0, 30.0, 1000.0]
    assert "__orig_price" not in out.columns


@REVIEW_RED
def test_normalize_preserves_nulls(executor):
    df = pd.DataFrame({"status": ["Active", None, " SHIPPED ", np.nan]})
    out = executor.apply_transforms(df.copy(), [rule("normalize", "status")])
    assert out["status"].tolist()[0] == "active"
    assert out["status"].tolist()[2] == "shipped"
    assert out["status"].isna().tolist() == [False, True, False, True]


@REVIEW_RED
def test_normalize_dates_keeps_unparseable_values_and_writes_sidecar(executor):
    vals = ["2024-01-05", "01/07/2024", "Jan 9 2024", "pending", "call back", "2024-02-01", "TBD"]
    out = executor.apply_transforms(pd.DataFrame({"when": vals}), [rule("normalize", "when")])
    got = out["when"].tolist()
    assert got[:3] == ["2024-01-05", "2024-01-07", "2024-01-09"]
    assert got[5] == "2024-02-01"
    assert got[3] == "pending" and got[4] == "call back" and got[6] == "tbd"
    assert out["__orig_when"].tolist() == vals


# ---------------------------------------------------------------- drop_nulls (M2)
@REVIEW_RED
def test_drop_nulls_column_rule_with_threshold_drops_null_rows(executor):
    """threshold=0.5 is the exact schema the suggest-transforms prompt documents."""
    df = pd.DataFrame({"id": range(10), "email": ["a@x"] * 9 + [None]})
    out = executor.apply_transforms(df.copy(), [rule("drop_nulls", "email", threshold=0.5)])
    assert len(out) == 9 and out["email"].notna().all()


# ---------------------------------------------------------------- silent failures (M3)
@REVIEW_RED
def test_failed_rule_leaves_no_half_applied_sidecar(executor):
    df = pd.DataFrame({"qty": ["1", "2.5", "3"]})
    out = executor.apply_transforms(df.copy(), [rule("type_cast", "qty", target_type="int")])
    assert list(out.columns) == ["qty"]
    assert out["qty"].tolist() == ["1", "2.5", "3"]
