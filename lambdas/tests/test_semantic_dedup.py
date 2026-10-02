"""semantic_deduplicate: MinHash + LSH banding (was an O(n^2) pure-Python scan).

Run 8afd8d39 (56,745 tweets, num_perm 120, threshold 0.9) stayed on Running until the
15-minute Lambda timeout because every row was compared with every kept row.
"""
import math
import os
import random
import subprocess
import sys
import time

import numpy as np
import pandas as pd
import pytest

from conftest import LAMBDAS, rule


@pytest.fixture(autouse=True)
def _no_invocation_deadline(executor):
    executor.set_invocation_deadline(None)
    yield
    executor.set_invocation_deadline(None)


def _synthetic(n, seed=7, vocab_size=20000, dup_rate=0.1):
    """Short tweet-like texts; dup_rate of them are an earlier row reshuffled / re-cased."""
    rng = random.Random(seed)
    vocab = [f"w{i}" for i in range(vocab_size)]
    rows = []
    for _ in range(n):
        if rows and rng.random() < dup_rate:
            src = rows[rng.randrange(len(rows))].split()
            rng.shuffle(src)
            rows.append(" ".join(w.upper() if rng.random() < 0.3 else w for w in src))
        else:
            rows.append(" ".join(rng.choice(vocab) for _ in range(rng.randint(8, 20))))
    return rows


def _apply(executor, df, column="text", **params):
    results = []
    out = executor.apply_transforms(df.copy(), [rule("semantic_deduplicate", column, **params)], results)
    return out, results[0]


# ------------------------------------------------------------------ behaviour
def test_drops_near_duplicates_and_keeps_first_occurrence(executor):
    base = " ".join(f"tok{i}" for i in range(40))
    df = pd.DataFrame({
        "text": [base, "something else entirely here", base.upper(), base + " extra", "something else entirely here"],
        "id": [1, 2, 3, 4, 5],
    })
    out, res = _apply(executor, df, threshold=0.8, num_perm=128)
    assert res["applied"] is True
    # 3 = same token set (case-insensitive), 4 = Jaccard 40/41, 5 = exact copy of 2
    assert out["id"].tolist() == [1, 2]
    assert out.index.tolist() == [0, 1]


def test_keeps_rows_below_the_threshold(executor):
    a = " ".join(f"a{i}" for i in range(10))
    b = " ".join([f"a{i}" for i in range(5)] + [f"b{i}" for i in range(5)])  # Jaccard 5/15
    df = pd.DataFrame({"text": [a, b, "unrelated words only"]})
    out, _ = _apply(executor, df, threshold=0.8, num_perm=64)
    assert len(out) == 3


def test_picks_the_first_text_column_when_none_is_given(executor):
    df = pd.DataFrame({"n": [1, 2, 3], "text": ["hello big world", "HELLO world big", "bye"]})
    out, res = _apply(executor, df, column=None, threshold=0.9)
    assert res["applied"] is True
    assert out["n"].tolist() == [1, 3]


def test_skips_without_a_text_column(executor):
    df = pd.DataFrame({"n": [1, 2, 2]})
    out, res = _apply(executor, df, column=None)
    assert res["applied"] is False and res["reason"] == "no text column to compare"
    assert out.equals(df)


@pytest.mark.parametrize("params", [{"threshold": 0}, {"threshold": 1.5}, {"num_perm": 0}, {"num_perm": 10_000}])
def test_rejects_invalid_parameters(executor, params):
    df = pd.DataFrame({"text": ["a b", "a b"]})
    out, res = _apply(executor, df, **params)
    assert res["applied"] is False
    assert out.equals(df)


def test_lsh_matches_brute_force_pairwise_comparison(executor):
    """Banding must not change the result: same signatures, same verdicts as comparing every pair."""
    rng = random.Random(11)
    vocab = [f"v{i}" for i in range(400)]
    rows = []
    for _ in range(1500):
        if rows and rng.random() < 0.35:
            src = rows[rng.randrange(len(rows))].split()
            src[rng.randrange(len(src))] = rng.choice(vocab)  # Jaccard around the threshold
            if rng.random() < 0.5:
                src.append(rng.choice(vocab))
            rows.append(" ".join(src))
        else:
            rows.append(" ".join(rng.choice(vocab) for _ in range(rng.randint(10, 25))))
    for threshold, num_perm in [(0.9, 120), (0.8, 64), (0.6, 32)]:
        deadline, desc = executor._rule_deadline()
        sigs = executor._minhash_signatures(rows, num_perm, deadline, desc)
        need = math.ceil(threshold * num_perm - 1e-9)
        brute = []
        for i in range(len(rows)):
            if brute and (np.count_nonzero(sigs[brute] == sigs[i], axis=1) >= need).any():
                continue
            brute.append(i)
        assert executor._semantic_dedup_keep(rows, threshold, num_perm) == brute, (threshold, num_perm)


@pytest.mark.parametrize("threshold,num_perm", [(0.9, 120), (0.8, 64), (0.8, 128), (0.5, 64), (0.95, 256), (0.7, 16)])
def test_lsh_params_catch_pairs_at_the_threshold(executor, threshold, num_perm):
    bands, r = executor._lsh_params(threshold, num_perm)
    assert 1 <= bands * r <= num_perm
    assert 1 - (1 - threshold ** r) ** bands >= 0.99


# --------------------------------------------------------------- determinism
_DET_ROWS = ["the quick brown fox", "Brown fox the QUICK", "lazy dog", ""]
# sha256 of the (4, 64) uint32 signatures of _DET_ROWS. Fixed forever: a change means
# semantic_deduplicate results changed for every existing pipeline.
_DET_DIGEST = "6256df0f7b30047f8ff9c5c22e27d1cf58fc8005dd465aca107e5b40c7a5519e"


def _det_digest(executor):
    import hashlib
    deadline, desc = executor._rule_deadline()
    return hashlib.sha256(executor._minhash_signatures(_DET_ROWS, 64, deadline, desc).tobytes()).hexdigest()


def test_signatures_are_pinned(executor):
    assert _det_digest(executor) == _DET_DIGEST
    assert executor._semantic_dedup_keep(_DET_ROWS, 0.8, 64) == [0, 2, 3]


def test_signatures_do_not_depend_on_pythonhashseed(executor):
    """The old code used built-in hash(), which PYTHONHASHSEED randomizes per process."""
    script = (
        "import sys, hashlib; sys.path.insert(0, sys.argv[1]);"
        "from conftest import load_handler; ex = load_handler('executor');"
        f"rows = {_DET_ROWS!r}; d, l = ex._rule_deadline();"
        "print(hashlib.sha256(ex._minhash_signatures(rows, 64, d, l).tobytes()).hexdigest())"
    )
    env = {**os.environ, "PYTHONHASHSEED": "12345"}
    out = subprocess.run([sys.executable, "-c", script, str(LAMBDAS / "tests")], env=env,
                         capture_output=True, text=True, check=True).stdout.strip()
    assert out == _DET_DIGEST


def test_same_input_gives_the_same_rows(executor):
    rows = _synthetic(3000, seed=5)
    assert executor._semantic_dedup_keep(rows, 0.9, 120) == executor._semantic_dedup_keep(list(rows), 0.9, 120)


# -------------------------------------------------------------------- guards
def test_row_cap_skips_instead_of_hanging(executor, monkeypatch):
    monkeypatch.setattr(executor, "SEMANTIC_DEDUP_MAX_ROWS", 10)
    df = pd.DataFrame({"text": ["same words"] * 11})
    out, res = _apply(executor, df)
    assert res["applied"] is False
    assert "exceeds the 10-row limit" in res["reason"]
    assert out.equals(df)


class _Ctx:
    def __init__(self, ms):
        self.ms = ms

    def get_remaining_time_in_millis(self):
        return self.ms


def test_skips_when_the_lambda_deadline_is_too_close(executor):
    executor.set_invocation_deadline(_Ctx(1))  # 1 ms left
    df = pd.DataFrame({"text": _synthetic(500)})
    out, res = _apply(executor, df, threshold=0.9, num_perm=120)
    assert res["applied"] is False
    assert "Lambda time limit" in res["reason"]
    assert out.equals(df)


def test_deadline_from_context_keeps_a_reserve(executor):
    executor.set_invocation_deadline(_Ctx(900_000))  # a fresh 15-minute invocation
    deadline, desc = executor._rule_deadline()
    assert desc == "the Lambda time limit"
    assert 900 - executor.LAMBDA_RESERVE_S - 5 < deadline - time.monotonic() <= 900 - executor.LAMBDA_RESERVE_S
    executor.set_invocation_deadline(object())  # no get_remaining_time_in_millis
    assert executor._rule_deadline()[1].endswith("time budget")


def test_handler_records_the_invocation_deadline(executor, monkeypatch):
    seen = []
    monkeypatch.setattr(executor, "process_run", lambda run_id, receive_count=1: seen.append(executor._invocation_deadline) or {"ok": True})
    executor.handler({"Records": [{"body": '{"run_id": "r1"}'}]}, _Ctx(60_000))
    assert seen and seen[0] is not None and seen[0] > time.monotonic()


# ---------------------------------------------------------------------- perf
@pytest.mark.perf
def test_50k_short_texts_finish_in_seconds(executor):
    """The O(n^2) version needed ~33 s for 4k rows and ~1.5 h for 50k; LSH takes a few seconds."""
    df = pd.DataFrame({"text": _synthetic(50_000), "id": range(50_000)})
    start = time.perf_counter()
    out, res = _apply(executor, df, threshold=0.9, num_perm=120)
    elapsed = time.perf_counter() - start
    assert res["applied"] is True
    assert 0.85 * len(df) < len(out) < len(df)  # ~10% of rows are reshuffled copies
    assert elapsed < 60, f"semantic_deduplicate took {elapsed:.1f}s for 50k rows"
