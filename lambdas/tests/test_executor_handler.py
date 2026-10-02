"""Executor handler: idempotent claims, retry semantics, raw-object cleanup."""
import json
from unittest import mock

import pytest

RAW_KEY = "user_1/pipe-1/run-1/raw.csv"
CSV = b"a,b\n x ,1\ny,2\n"


class FakeCursor:
    def __init__(self, claim=True):
        self.sql = []
        self._rows = []
        self.claim = claim
        self.rules = [("rule-1", "trim_whitespace", None, {}), ("rule-2", "normalize", "missing", {})]

    def execute(self, q, params=None):
        flat = " ".join(q.split())
        self.sql.append((flat, params))
        if flat.startswith("UPDATE pipeline_runs SET status = 'running'"):
            self._rows = [("run-1",)] if self.claim else []
        elif "FROM pipeline_runs pr JOIN pipelines p" in flat:
            self._rows = [("pipe-1", RAW_KEY, "csv", "tabular", 1, None, False, 2, True)]
        elif "FROM transform_rules" in flat:
            self._rows = list(self.rules)
        else:
            self._rows = []

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows

    def close(self):
        pass


class FakeConn:
    def __init__(self, cursor):
        self.c = cursor
        self.commits = 0

    def cursor(self):
        return self.c

    def commit(self):
        self.commits += 1

    def rollback(self):
        pass

    def close(self):
        pass


def _s3(get_side_effect=None):
    s3 = mock.MagicMock()
    if get_side_effect is not None:
        s3.get_object.side_effect = get_side_effect
    else:
        s3.get_object.return_value = {"Body": mock.MagicMock(read=mock.MagicMock(return_value=CSV))}
    paginator = mock.MagicMock()
    paginator.paginate.return_value = [{
        "Versions": [{"Key": RAW_KEY, "VersionId": "v1"}, {"Key": "user_1/pipe-1/run-1/extracted_text.txt", "VersionId": "v2"}],
        "DeleteMarkers": [{"Key": RAW_KEY, "VersionId": "dm1"}],
    }]
    s3.get_paginator.return_value = paginator
    return s3


def _event(receive_count="1"):
    return {"Records": [{"body": json.dumps({"run_id": "run-1"}), "attributes": {"ApproximateReceiveCount": receive_count}}]}


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("S3_RAW_BUCKET", "raw")
    monkeypatch.setenv("S3_PROCESSED_BUCKET", "proc")
    monkeypatch.delenv("SNS_DRIFT_TOPIC_ARN", raising=False)


def _statuses(cur):
    return [q for q, _ in cur.sql if q.startswith("UPDATE pipeline_runs")]


def test_duplicate_message_is_a_noop(executor):
    cur = FakeCursor(claim=False)
    s3 = _s3()
    with mock.patch.object(executor, "get_db_conn", return_value=FakeConn(cur)), mock.patch.object(executor, "s3", s3):
        out = executor.handler(_event(), None)
    assert out["skipped"] is True
    s3.get_object.assert_not_called()
    assert len(_statuses(cur)) == 1  # only the conditional claim, no status overwrite
    assert "AND (status = 'queued'" in cur.sql[0][0]


def test_success_writes_clean_deliverable_records_results_and_purges_raw(executor):
    cur = FakeCursor()
    s3 = _s3()
    with mock.patch.object(executor, "get_db_conn", return_value=FakeConn(cur)), mock.patch.object(executor, "s3", s3):
        out = executor.handler(_event(), None)
    assert out == {"statusCode": 200, "run_id": "run-1"}
    puts = {c.kwargs["Key"]: c.kwargs["Body"] for c in s3.put_object.call_args_list}
    assert b"__orig_" not in puts["processed/pipe-1/run-1/output.csv"]
    # rule results persisted onto transform_rules.parameters._execution
    results = [json.loads(p[0]) for q, p in cur.sql if q.startswith("UPDATE transform_rules")]
    assert results[0]["_execution"]["applied"] is True
    assert results[1]["_execution"]["applied"] is False
    assert any("SET status = 'completed'" in q for q in _statuses(cur))
    # all versions + delete markers under the run prefix (incl. extracted_text.txt) deleted
    deleted = s3.delete_objects.call_args.kwargs["Delete"]["Objects"]
    assert {(o["Key"], o["VersionId"]) for o in deleted} == {
        (RAW_KEY, "v1"), ("user_1/pipe-1/run-1/extracted_text.txt", "v2"), (RAW_KEY, "dm1")}
    s3.get_paginator.return_value.paginate.assert_called_with(Bucket="raw", Prefix="user_1/pipe-1/run-1/")


def test_transient_failure_releases_claim_and_raises_for_retry(executor):
    cur = FakeCursor()
    s3 = _s3(get_side_effect=RuntimeError("throttled"))
    with mock.patch.object(executor, "get_db_conn", return_value=FakeConn(cur)), mock.patch.object(executor, "s3", s3):
        with pytest.raises(RuntimeError, match="executor will retry"):
            executor.handler(_event("1"), None)
    assert any("SET status = 'queued'" in q for q in _statuses(cur))
    assert not any("SET status = 'failed'" in q for q in _statuses(cur))


def test_final_attempt_marks_failed_without_raising(executor):
    cur = FakeCursor()
    s3 = _s3(get_side_effect=RuntimeError("NoSuchKey"))
    with mock.patch.object(executor, "get_db_conn", return_value=FakeConn(cur)), mock.patch.object(executor, "s3", s3):
        out = executor.handler(_event("3"), None)
    assert out["failed"] is True
    assert any("SET status = 'failed'" in q for q in _statuses(cur))


def test_post_completion_failure_keeps_run_completed_and_still_purges_raw(executor):
    cur = FakeCursor()
    s3 = _s3()
    with mock.patch.object(executor, "get_db_conn", return_value=FakeConn(cur)), mock.patch.object(executor, "s3", s3), \
         mock.patch.object(executor, "schema_hash", side_effect=RuntimeError("boom")):
        out = executor.handler(_event(), None)
    assert out == {"statusCode": 200, "run_id": "run-1"}
    assert not any("SET status = 'failed'" in q or "SET status = 'queued'" in q for q in _statuses(cur))
    s3.delete_objects.assert_called_once()  # a drift failure must not leave raw data behind


def test_redelivery_after_success_does_not_fail_the_run(executor):
    """Review H4 repro: 2nd delivery after a completed run used to hit NoSuchKey and mark it failed."""
    first, second = FakeCursor(), FakeCursor(claim=False)
    s3 = _s3()
    with mock.patch.object(executor, "s3", s3):
        with mock.patch.object(executor, "get_db_conn", return_value=FakeConn(first)):
            assert executor.handler(_event(), None) == {"statusCode": 200, "run_id": "run-1"}
        s3.get_object.side_effect = RuntimeError("NoSuchKey")  # raw is gone now
        with mock.patch.object(executor, "get_db_conn", return_value=FakeConn(second)):
            assert executor.handler(_event("2"), None)["skipped"] is True
    assert not any("SET status = 'failed'" in q for q in _statuses(second))


def test_every_record_in_a_batch_is_processed(executor):
    seen = []
    with mock.patch.object(executor, "process_run", side_effect=lambda rid, n: seen.append(rid) or {"run_id": rid}):
        out = executor.handler({"Records": [{"body": json.dumps({"run_id": r})} for r in ("a", "b", "c")]}, None)
    assert seen == ["a", "b", "c"] and len(out["results"]) == 3


def test_audit_file_written_when_sidecars_exist(executor):
    cur = FakeCursor()
    cur.rules = [("rule-1", "type_cast", "b", {"target_type": "float"})]
    s3 = _s3()
    with mock.patch.object(executor, "get_db_conn", return_value=FakeConn(cur)), mock.patch.object(executor, "s3", s3):
        executor.handler(_event(), None)
    puts = {c.kwargs["Key"]: c.kwargs["Body"] for c in s3.put_object.call_args_list}
    assert b"__orig_" not in puts["processed/pipe-1/run-1/output.csv"]
    assert b"__orig_b" in puts["processed/pipe-1/run-1/audit.csv"]


def test_purge_falls_back_to_current_versions_when_listing_denied(executor):
    s3 = mock.MagicMock()
    s3.get_paginator.return_value.paginate.side_effect = Exception("AccessDenied")
    out = executor.delete_raw_run_objects(s3, "raw", RAW_KEY)
    assert out["mode"] == "current_only"
    keys = [c.kwargs["Key"] for c in s3.delete_object.call_args_list]
    assert keys == [RAW_KEY, "user_1/pipe-1/run-1/extracted_text.txt"]


def test_purge_refuses_non_run_scoped_prefix(executor):
    s3 = mock.MagicMock()
    out = executor.delete_raw_run_objects(s3, "raw", "raw.csv")
    s3.get_paginator.assert_not_called()
    assert out["mode"] == "current_only"
