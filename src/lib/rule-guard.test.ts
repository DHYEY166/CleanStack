import { describe, expect, it } from "vitest";
import { applyRuleGuard, guardRule, isMostlyNumeric, isPlaceholder, ruleGuardOf } from "@/lib/rule-guard";

// Profiler column_stats: min/max are set only when at least half the column is numeric.
const stats = {
  score: { type: "object", min: 1, max: 900, sentinel_examples: [".", ""] },
  price: { type: "float64", min: 0.5, max: 10 },
  status: { type: "object", sentinel_examples: ["N/A"] },
  email: { type: "object" },
};

const rule = (rule_type: string, column_name: string | null, parameters: Record<string, unknown>) =>
  ({ rule_type, column_name, parameters });

describe("guardRule flags rules that remove rows for one bad cell", () => {
  it("flags removing a non-number from a mostly numeric column", () => {
    const g = guardRule(rule("filter", "score", { operator: "neq", value: "." }), stats);
    expect(g?.values).toEqual(["."]);
    expect(g?.reason).toMatch(/Consider converting that value to blank/);
    expect(g?.alternative).toEqual({
      rule_type: "type_cast", column_name: "score", parameters: { target_type: "float", null_values: ["."] },
    });
    expect(guardRule(rule("filter", "price", { operator: "neq", value: "abc" }), stats)?.values).toEqual(["abc"]);
  });

  it("flags placeholder tokens in any column", () => {
    const g = guardRule(rule("filter_extended", "status", { operator: "not_in", values: ["N/A", "?"] }), stats);
    expect(g?.values).toEqual(["N/A", "?"]);
    expect(g?.alternative).toBeNull(); // not a numeric column: no cast to suggest
    expect(guardRule(rule("filter_extended", "email", { operator: "not_contains", value: "n/a" }), stats)).not.toBeNull();
  });

  it("flags drop_nulls that runs after a numeric cast blanked placeholders", () => {
    const rules = [
      rule("type_cast", "score", { target_type: "int" }),
      rule("drop_nulls", "score", {}),
    ];
    const out = applyRuleGuard(rules, stats);
    expect(ruleGuardOf(out[0].parameters)).toBeNull();
    expect(ruleGuardOf(out[1].parameters)?.values).toEqual(["."]);
  });
});

describe("guardRule leaves legitimate filters alone", () => {
  it.each([
    ["a numeric value", rule("filter", "score", { operator: "neq", value: 0 })],
    ["a numeric string", rule("filter", "score", { operator: "neq", value: "999" })],
    ["a comparison", rule("filter", "score", { operator: "gt", value: 0 })],
    ["a keep-only match", rule("filter", "status", { operator: "eq", value: "active" })],
    ["a real text value", rule("filter", "status", { operator: "neq", value: "deleted" })],
    ["test accounts", rule("filter_extended", "email", { operator: "not_in", values: ["test", "demo"] })],
    ["a real substring", rule("filter_extended", "email", { operator: "not_contains", value: "@spam." })],
    ["a regex", rule("filter_extended", "score", { operator: "regex", value: "^\\d+$" })],
    ["blank cells", rule("filter", "score", { operator: "neq", value: "" })],
    ["drop_nulls without a cast", rule("drop_nulls", "score", {})],
    ["drop_nulls on all columns", rule("drop_nulls", null, { threshold: 0.5 })],
    ["a non-row-removing rule", rule("type_cast", "score", { target_type: "int" })],
    ["an unknown column", rule("filter", "nope", { operator: "neq", value: "x" })],
  ])("does not flag %s", (_label, r) => {
    expect(guardRule(r, stats)).toBeNull();
  });

  it("leaves unflagged rules untouched", () => {
    const r = rule("filter", "status", { operator: "neq", value: "deleted" });
    expect(applyRuleGuard([r], stats)[0]).toBe(r);
  });
});

describe("helpers", () => {
  it("recognises placeholders and mostly numeric columns", () => {
    expect(isPlaceholder(" N/A ")).toBe(true);
    expect(isPlaceholder("#DIV/0!")).toBe(true);
    expect(isPlaceholder("Brownie")).toBe(false);
    expect(isPlaceholder("")).toBe(false);
    expect(isMostlyNumeric(stats.score)).toBe(true);
    expect(isMostlyNumeric(stats.price)).toBe(true);
    expect(isMostlyNumeric(stats.status)).toBe(false);
    expect(isMostlyNumeric(undefined)).toBe(false);
  });
  it("reads only well-formed guard records", () => {
    expect(ruleGuardOf(null)).toBeNull();
    expect(ruleGuardOf({ _guard: "x" })).toBeNull();
    expect(ruleGuardOf({ _guard: { reason: "r", values: ["."] } })).toEqual({ reason: "r", values: ["."], alternative: null });
  });
});
