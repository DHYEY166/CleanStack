"""Smoke test: every Lambda handler imports with the pinned dependencies (M8)."""
import pytest

from conftest import load_handler


@pytest.mark.parametrize("name", ["profiler", "executor", "drift", "ai-trigger"])
def test_handler_imports_and_exposes_entrypoint(name):
    module = load_handler(name)
    assert callable(module.handler)
