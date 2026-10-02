"""Profiler upload size limits (mirror of src/lib/upload-limits.ts)."""
import pytest


def test_guest_keys_get_the_2mb_limit(profiler):
    assert profiler.max_upload_bytes("guest_abcdefghijklmnopqrstuv/p/r/raw.csv") == 2 * 1024 * 1024


@pytest.mark.parametrize("env,expected_mb", [(None, 100), ("50", 50), ("0.5", 0.5), ("junk", 100), ("-1", 100)])
def test_user_limit_defaults_to_100mb_and_honours_max_upload_mb(profiler, monkeypatch, env, expected_mb):
    if env is None:
        monkeypatch.delenv("MAX_UPLOAD_MB", raising=False)
    else:
        monkeypatch.setenv("MAX_UPLOAD_MB", env)
    assert profiler.max_upload_bytes("user_2abc/p/r/raw.csv") == int(expected_mb * 1024 * 1024)


def test_oversized_object_is_rejected_before_reading(profiler, monkeypatch):
    class Body:
        closed = False
        def read(self):
            raise AssertionError("must not read an oversized object")
        def close(self):
            Body.closed = True

    monkeypatch.setattr(profiler.s3, "get_object", lambda **kw: {"Body": Body(), "ContentLength": 3 * 1024 * 1024})
    rejected = []
    monkeypatch.setattr(profiler, "_reject_too_large", lambda run_id, size, limit: rejected.append((run_id, size, limit)) or {"rejected": "too_large"})
    event = {"Records": [{"s3": {"bucket": {"name": "b"}, "object": {"key": "guest_abcdefghijklmnopqrstuv/p/run-1/raw.csv"}}}]}
    assert profiler.handler(event, None) == {"rejected": "too_large"}
    assert rejected == [("run-1", 3 * 1024 * 1024, 2 * 1024 * 1024)]
    assert Body.closed
