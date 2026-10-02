"""The cleaned deliverable never carries __orig_* audit columns (review H1/H2)."""
import pandas as pd
import pytest

from conftest import rule


def _cleaned_with_sidecar(executor):
    df = pd.DataFrame({"name": ['Smith, John', 'Doe, "Jane"'], "amount": ["$1,000", "$20"]})
    return executor.apply_transforms(df, [rule("type_cast", "amount", target_type="float")])


def test_split_deliverable_separates_audit_columns(executor):
    deliverable, audit = executor.split_deliverable(_cleaned_with_sidecar(executor))
    assert list(deliverable.columns) == ["name", "amount"]
    assert list(audit.columns) == ["name", "amount", "__orig_amount"]
    assert audit["__orig_amount"].tolist() == ["$1,000", "$20"]


def test_split_deliverable_without_sidecars_returns_frame_unchanged(executor):
    df = pd.DataFrame({"a": [1]})
    deliverable, audit = executor.split_deliverable(df)
    assert deliverable is df and audit is None


@pytest.mark.parametrize("fmt", ["csv", "txt", "tsv", "json", "jsonl", "xml"])
def test_written_deliverable_has_no_sidecars_and_round_trips(executor, fmt):
    deliverable, _ = executor.split_deliverable(_cleaned_with_sidecar(executor))
    body, _, ext = executor.save_dataframe(deliverable, fmt)
    assert b"__orig_" not in body
    back = executor.load_raw_dataframe(body, ext)
    # quoted commas and quotes survive intact: nothing shifts columns any more
    assert back["name"].tolist() == ['Smith, John', 'Doe, "Jane"']
    assert [float(v) for v in back["amount"].tolist()] == [1000.0, 20.0]


def test_xlsx_deliverable_has_no_sidecars(executor):
    deliverable, _ = executor.split_deliverable(_cleaned_with_sidecar(executor))
    body, _, ext = executor.save_dataframe(deliverable, "xlsx")
    assert list(executor.load_raw_dataframe(body, ext).columns) == ["name", "amount"]


def test_audit_key_sits_next_to_the_output(executor):
    assert executor.audit_key_for("processed/p1/r1/output.json") == "processed/p1/r1/audit.csv"
