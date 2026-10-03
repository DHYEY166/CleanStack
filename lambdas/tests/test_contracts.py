"""Cross-language contracts that must not drift: checked by code, not by convention."""
import pathlib
import re

REPO = pathlib.Path(__file__).resolve().parents[2]


def _ts_tabular_rule_enum() -> set:
    src = (REPO / "src/app/api/suggest-transforms/route.ts").read_text()
    block = src[src.index("const ruleSchema"):src.index("const documentRuleSchema")]
    enum = block[block.index("z.enum(["):block.index("])")]
    return set(re.findall(r'"([a-z_]+)"', enum))


def test_ai_can_only_suggest_rules_the_executor_implements(executor):
    """Every tabular rule type the model may return must be executable (no silent no-ops)."""
    assert _ts_tabular_rule_enum() == executor.SUPPORTED_TABULAR_RULES


def _ts_risk_threshold_keys() -> set:
    src = (REPO / "src/app/api/auto-validate/[runId]/route.ts").read_text()
    block = src[src.index("const RISK_THRESHOLDS"):]
    block = block[:block.index("};")]
    return set(re.findall(r"^\s*([a-z_]+):\s*\d", block, re.M))


def test_every_executable_rule_has_a_committee_threshold(executor):
    """auto-validate must know the risk tier of every rule the executor can run."""
    missing = executor.SUPPORTED_TABULAR_RULES - _ts_risk_threshold_keys()
    assert not missing, missing


def test_committee_has_no_thresholds_for_unimplemented_rules(executor):
    documents = {"strip_pii", "ner_redact", "normalize_whitespace", "strip_html", "fix_encoding",
                 "remove_blank_lines", "remove_headers_footers", "redact_pattern"}
    extra = _ts_risk_threshold_keys() - executor.SUPPORTED_TABULAR_RULES - documents
    assert not extra, extra


def test_sidecar_prefix_matches_typescript(executor):
    src = (REPO / "src/lib/sidecar.ts").read_text()
    assert f'SIDECAR_PREFIX = "{executor.SIDECAR_PREFIX}"' in src


def test_placeholder_tokens_match_typescript(executor):
    """The bad-cell guard flags the same placeholders in the Data PR and in the executor."""
    src = (REPO / "src/lib/rule-guard.ts").read_text()
    block = src[src.index("PLACEHOLDER_TOKENS"):]
    block = block[block.index("["):block.index("];")]
    assert set(re.findall(r'"([^"]*)"', block)) == set(executor.PLACEHOLDER_TOKENS)
