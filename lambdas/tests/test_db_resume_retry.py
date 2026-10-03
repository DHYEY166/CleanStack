"""Every Lambda that connects to Aurora retries a failed connect while the cluster resumes
from auto-pause, never retries authentication errors, and gives up after its budget."""
import psycopg2
import pytest


@pytest.fixture(params=["profiler", "executor", "drift"])
def handler(request):
    return request.getfixturevalue(request.param)


class FakeClock:
    def __init__(self):
        self.t = 0.0
        self.sleeps = []

    def monotonic(self):
        return self.t

    def sleep(self, s):
        self.sleeps.append(s)
        self.t += s


@pytest.fixture
def clock(handler, monkeypatch):
    c = FakeClock()
    monkeypatch.setattr(handler.time, "monotonic", c.monotonic)
    monkeypatch.setattr(handler.time, "sleep", c.sleep)
    return c


def _connect_failing(monkeypatch, handler, errors, result="conn"):
    calls = []

    def fake_connect(**kwargs):
        calls.append(kwargs)
        if len(calls) <= len(errors):
            raise errors[len(calls) - 1]
        return result

    monkeypatch.setattr(handler.psycopg2, "connect", fake_connect)
    return calls


def test_retries_while_resuming_then_connects(handler, clock, monkeypatch, capsys):
    err = psycopg2.OperationalError("could not connect to server: Connection timed out")
    calls = _connect_failing(monkeypatch, handler, [err, err, err])
    assert handler._connect_with_resume_retry(host="h", dbname="d") == "conn"
    assert len(calls) == 4 and calls[-1] == {"host": "h", "dbname": "d"}
    assert clock.sleeps == [1, 2, 4]
    out = capsys.readouterr().out
    assert out.count("database may be resuming") == 1  # one log line per connect


def test_authentication_errors_are_not_retried(handler, clock, monkeypatch):
    err = psycopg2.OperationalError('FATAL:  PAM authentication failed for user "cleanstack"')
    calls = _connect_failing(monkeypatch, handler, [err])
    with pytest.raises(psycopg2.OperationalError, match="authentication failed"):
        handler._connect_with_resume_retry(host="h")
    assert len(calls) == 1 and clock.sleeps == []


def test_other_exceptions_are_not_retried(handler, clock, monkeypatch):
    calls = _connect_failing(monkeypatch, handler, [ValueError("bad dsn")])
    with pytest.raises(ValueError):
        handler._connect_with_resume_retry(host="h")
    assert len(calls) == 1 and clock.sleeps == []


def test_gives_up_after_the_budget(handler, clock, monkeypatch):
    err = psycopg2.OperationalError("could not connect to server")
    calls = _connect_failing(monkeypatch, handler, [err] * 100)
    with pytest.raises(psycopg2.OperationalError):
        handler._connect_with_resume_retry(host="h")
    assert clock.sleeps == [1, 2, 4, 8, 8, 8]
    assert sum(clock.sleeps) <= handler.DB_CONNECT_RETRY_BUDGET_S
    assert len(calls) == len(clock.sleeps) + 1


def test_get_db_conn_uses_the_retry(handler):
    import inspect
    assert "_connect_with_resume_retry(" in inspect.getsource(handler.get_db_conn)
