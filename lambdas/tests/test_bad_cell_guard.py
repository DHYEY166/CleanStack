"""Bad-cell guard: a row-removing rule that drops otherwise valid rows only because ONE cell
holds a placeholder or (in a mostly numeric column) a non-number is reported, and skipped in
auto mode. Legitimate filters are never flagged."""
import pandas as pd
import pytest

from conftest import rule


def _frame():
    # 10 rows (the row-loss guard allows 20% per rule); row 3 has one bad score cell,
    # row 9 is a mostly empty spacer whose only value is a placeholder.
    names = [f"item {i}" for i in range(10)]
    scores = [10, 20, 30, ".", 50, 60, 70, 80, 90, "."]
    status = ["active"] * 8 + ["deleted", None]
    cities = ["Austin"] * 9 + [None]
    names[9] = None
    return pd.DataFrame({"name": names, "score": scores, "status": status, "city": cities})


def _run(executor, df, rules, **kw):
    results = []
    out = executor.apply_transforms(df.copy(), rules, results, **kw)
    return out, results


def test_reports_rows_removed_for_one_bad_cell(executor):
    out, res = _run(executor, _frame(), [rule("filter", "score", operator="neq", value=".")])
    assert res[0]["applied"] is True
    assert res[0]["rows_removed"] == 2
    assert res[0]["bad_cell_rows"] == 1  # row 3; the spacer row is not "otherwise valid"
    assert "item 3" not in set(out["name"])


def test_auto_mode_skips_the_rule_and_keeps_the_rows(executor):
    df = _frame()
    out, res = _run(executor, df, [rule("filter", "score", operator="neq", value=".")],
                    skip_bad_cell_rules=True)
    assert res[0]["applied"] is False
    assert res[0]["reason"].startswith("guard: would remove 1 row(s) only because of one bad cell")
    assert res[0]["rows_removed"] == 0
    assert res[0]["bad_cell_rows"] == 1
    assert len(out) == len(df)


def test_placeholder_in_a_text_column_is_flagged(executor):
    df = _frame()
    df.loc[2, "status"] = "N/A"
    _, res = _run(executor, df, [rule("filter_extended", "status", operator="not_in", values=["N/A"])])
    assert res[0]["bad_cell_rows"] == 1


def test_drop_nulls_after_a_cast_counts_the_blanked_placeholder(executor):
    df = _frame()
    df.loc[5, "city"] = None  # a real blank elsewhere does not matter
    out, res = _run(executor, df, [rule("type_cast", "score", target_type="float"),
                                   rule("drop_nulls", "score")])
    assert res[1]["rows_removed"] == 2
    assert res[1]["bad_cell_rows"] == 1


@pytest.mark.parametrize("rules", [
    [rule("filter", "status", operator="neq", value="deleted")],        # real value in a text column
    [rule("filter", "score", operator="gt", value=15)],                 # comparison
    [rule("filter", "score", operator="neq", value=10)],                # a number
    [rule("filter", "status", operator="eq", value="active")],          # keep-only
    [rule("drop_nulls", "status")],                                     # raw blanks
    [rule("filter_extended", "name", operator="not_contains", value="item 1")],
])
def test_legitimate_filters_are_not_flagged(executor, rules):
    df = _frame()
    out, res = _run(executor, df, rules, skip_bad_cell_rules=True)
    assert res[0]["bad_cell_rows"] == 0
    assert res[0]["applied"] is True
    assert res[0]["rows_removed"] == len(df) - len(out)


def test_single_column_file_is_not_flagged(executor):
    df = pd.DataFrame({"score": [1, 2, 3, 4, 5, 6, 7, 8, 9, "."]})
    _, res = _run(executor, df, [rule("filter", "score", operator="neq", value=".")],
                  skip_bad_cell_rules=True)
    assert res[0]["applied"] is True and res[0]["bad_cell_rows"] == 0


def test_non_row_removing_rules_report_zero(executor):
    _, res = _run(executor, _frame(), [rule("type_cast", "score", target_type="float")])
    assert res[0]["bad_cell_rows"] == 0
