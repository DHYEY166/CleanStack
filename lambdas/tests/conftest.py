"""Shared fixtures: load each Lambda handler module by path (they are all named handler.py)."""
import importlib.util
import os
import pathlib

import pytest

# Handlers build boto3 clients and read a few env vars at import time.
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("APP_URL", "https://app.example.test")
os.environ.setdefault("WEBHOOK_SECRET", "test-webhook-secret")

LAMBDAS = pathlib.Path(__file__).resolve().parents[1]


def load_handler(name: str):
    """Import lambdas/<name>/handler.py under a unique module name."""
    spec = importlib.util.spec_from_file_location(f"cleanstack_{name.replace('-', '_')}_handler",
                                                  LAMBDAS / name / "handler.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="session")
def executor():
    return load_handler("executor")


@pytest.fixture(scope="session")
def profiler():
    return load_handler("profiler")


@pytest.fixture(scope="session")
def drift():
    return load_handler("drift")


def rule(rule_type, column=None, rule_id=None, **params):
    """Build a transform_rules row the way the executor reads it from Postgres."""
    return {"id": rule_id, "rule_type": rule_type, "column_name": column, "parameters": params}


def pytest_configure(config):
    config.addinivalue_line("markers", "perf: performance bound with a generous limit (run in CI)")
