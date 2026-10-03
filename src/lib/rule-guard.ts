/**
 * Deterministic guard for AI-suggested row-removing rules (no AI involved).
 *
 * A rule is flagged when it would remove rows only because ONE cell holds a bad
 * value: a common placeholder token ("N/A", "-", "?", ...) or, in a column that
 * is mostly numeric, a value that is not a number. The rest of such a row is
 * usually valid data, so the better fix is to turn that cell into a blank
 * (type_cast with null_values) and keep the row.
 *
 * Legitimate filters are not flagged: comparisons (gt/lt/...), keep-only
 * filters (eq/in/regex), numeric values (neq 0), and real text values in text
 * columns (neq "deleted", not_in ["test"]). Removing blank cells ("" or
 * drop_nulls on raw nulls) is not flagged either.
 *
 * Flagged rules get parameters._guard. The Data PR shows its warning and leaves
 * the rule out of "Approve all", and auto-validate rejects it without a vote.
 * The executor runs the same check on the real rows (lambdas/executor/handler.py,
 * PLACEHOLDER_TOKENS must stay identical: test_contracts.py) and reports the
 * count; in auto mode it skips such a rule.
 */

export const PLACEHOLDER_TOKENS: readonly string[] = [
  ".", "..", "...", "-", "--", "---", "?", "??", "???",
  "n/a", "na", "n.a.", "n.a", "#n/a", "null", "none", "nil", "nan", "missing",
  "unknown", "undefined", "not available", "not applicable", "tbd", "tbc",
  "#value!", "#ref!", "#div/0!", "#name?", "#num!", "#null!", "#error!",
];

const PLACEHOLDERS = new Set(PLACEHOLDER_TOKENS);

export interface RuleGuard {
  reason: string;
  /** The values in `column` the rule removes rows for. */
  values: string[];
  /** A rule that keeps the rows and blanks the bad cells, when one exists. */
  alternative: { rule_type: "type_cast"; column_name: string; parameters: { target_type: "float"; null_values: string[] } } | null;
}

interface GuardRule {
  rule_type: string;
  column_name: string | null;
  parameters: Record<string, unknown> | null;
}

/** The parts of a profiler column_stats entry the guard reads. */
interface GuardColumnStat {
  type?: unknown;
  min?: unknown;
  sentinel_examples?: unknown;
}

export function isPlaceholder(v: unknown): boolean {
  return PLACEHOLDERS.has(String(v ?? "").trim().toLowerCase());
}

export function isNumberText(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  const s = String(v ?? "").trim().replace(/[$,]/g, "");
  return s !== "" && Number.isFinite(Number(s));
}

/** The profiler sets min/max only when at least half the column parses as numbers. */
export function isMostlyNumeric(stat: GuardColumnStat | undefined): boolean {
  if (!stat) return false;
  return typeof stat.min === "number" || /^(int|float|uint)/.test(String(stat.type ?? ""));
}

function isBadCell(v: unknown, mostlyNumeric: boolean): boolean {
  const s = String(v ?? "").trim();
  if (s === "") return false; // blanks are nulls: removing them is drop_nulls, not a bad cell
  return isPlaceholder(s) || (mostlyNumeric && !isNumberText(s));
}

const NUMERIC_CASTS = new Set(["float", "float64", "numeric", "number", "int", "int64"]);

/** Values whose rows the rule removes (only for rules that remove rows by matching a value). */
function removedValues(rule: GuardRule, earlier: GuardRule[], stat: GuardColumnStat | undefined): unknown[] {
  const p = rule.parameters ?? {};
  const op = p.operator;
  if (rule.rule_type === "filter" || rule.rule_type === "filter_extended") {
    if (op === "neq") return [p.value];
    if (rule.rule_type === "filter_extended" && op === "not_in") return Array.isArray(p.values) ? p.values : [];
    if (rule.rule_type === "filter_extended" && op === "not_contains") return isPlaceholder(p.value) ? [p.value] : [];
    return [];
  }
  if (rule.rule_type === "drop_nulls" && rule.column_name) {
    // drop_nulls after a numeric type_cast of the same column also drops the rows whose
    // placeholder the cast turned into null.
    const castFirst = earlier.some((r) => r.rule_type === "type_cast" && r.column_name === rule.column_name
      && NUMERIC_CASTS.has(String(r.parameters?.target_type ?? "")));
    if (!castFirst) return [];
    return Array.isArray(stat?.sentinel_examples) ? stat.sentinel_examples : [];
  }
  return [];
}

export function guardRule(rule: GuardRule, columnStats: Record<string, GuardColumnStat>, earlier: GuardRule[] = []): RuleGuard | null {
  const col = rule.column_name;
  if (!col) return null;
  const stat = columnStats[col];
  const mostlyNumeric = isMostlyNumeric(stat);
  const bad = removedValues(rule, earlier, stat).filter((v) => isBadCell(v, mostlyNumeric)).map((v) => String(v).trim());
  if (!bad.length) return null;
  const shown = bad.slice(0, 5).map((v) => `"${v}"`).join(", ");
  const why = mostlyNumeric ? "a placeholder or non-number in a mostly numeric column" : "a placeholder";
  return {
    reason: `Would remove every row where "${col}" is ${shown} (${why}), even if the rest of the row is valid. `
      + (mostlyNumeric
        ? `Consider converting that value to blank instead: type_cast "${col}" with null_values [${shown}].`
        : "Consider keeping these rows: the value only means the cell is unknown."),
    values: bad,
    alternative: mostlyNumeric
      ? { rule_type: "type_cast", column_name: col, parameters: { target_type: "float", null_values: bad } }
      : null,
  };
}

/** Returns the rules with parameters._guard set on every flagged rule (order and content otherwise unchanged). */
export function applyRuleGuard<T extends GuardRule>(rules: T[], columnStats: Record<string, GuardColumnStat>): T[] {
  return rules.map((rule, i) => {
    const guard = guardRule(rule, columnStats, rules.slice(0, i));
    return guard ? { ...rule, parameters: { ...(rule.parameters ?? {}), _guard: guard } } : rule;
  });
}

/** The guard record stored on a rule, or null. */
export function ruleGuardOf(parameters: Record<string, unknown> | null | undefined): RuleGuard | null {
  const g = parameters?._guard;
  if (!g || typeof g !== "object") return null;
  const r = g as Record<string, unknown>;
  if (typeof r.reason !== "string") return null;
  return {
    reason: r.reason,
    values: Array.isArray(r.values) ? r.values.map(String) : [],
    alternative: (r.alternative as RuleGuard["alternative"]) ?? null,
  };
}
