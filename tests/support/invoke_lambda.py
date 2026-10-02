"""Invoke one Lambda handler in-process with an event read from stdin.

    python tests/support/invoke_lambda.py executor < event.json

Prints handler logs, then a final line `__RESULT__ <json>` with the return
value, or `__ERROR__ <message>` (exit 1) if the handler raised.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lambda_harness import load  # noqa: E402


def main() -> int:
    name = sys.argv[1]
    event = json.load(sys.stdin)
    module = load(name)
    try:
        result = module.handler(event, None)
    except Exception as e:  # report to the caller, which asserts on it
        print(f"__ERROR__ {type(e).__name__}: {e}", flush=True)
        return 1
    print(f"__RESULT__ {json.dumps(result, default=str)}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
