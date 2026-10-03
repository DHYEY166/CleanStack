import { describe, expect, it } from "vitest";
import { badCellRowsByRules, isApprovedButNotApplied, removesRows, ruleExecution, rowsRemovedByRules } from "@/lib/types";

describe("ruleExecution", () => {
  it("reads the executor's _execution record", () => {
    expect(ruleExecution({ _execution: { applied: false, reason: "cannot cast", rows_removed: 0 } }))
      .toEqual({ applied: false, reason: "cannot cast", rows_removed: 0, bad_cell_rows: null });
    expect(ruleExecution({ _execution: { applied: true, reason: null, rows_removed: 1, bad_cell_rows: 1 } }))
      .toEqual({ applied: true, reason: null, rows_removed: 1, bad_cell_rows: 1 });
  });
  it("treats a missing or malformed row count as unknown (runs from before it was recorded)", () => {
    expect(ruleExecution({ _execution: { applied: true } })).toEqual({ applied: true, reason: null, rows_removed: null, bad_cell_rows: null });
    expect(ruleExecution({ _execution: { applied: true, rows_removed: -2 } })?.rows_removed).toBeNull();
    expect(ruleExecution({ _execution: { applied: true, rows_removed: "3" } })?.rows_removed).toBeNull();
  });
  it("returns null when the rule has not run or the record is malformed", () => {
    expect(ruleExecution(null)).toBeNull();
    expect(ruleExecution({ method: "minmax" })).toBeNull();
    expect(ruleExecution({ _execution: { applied: "no" } })).toBeNull();
  });
});

describe("isApprovedButNotApplied", () => {
  it("flags only approved rules the executor skipped", () => {
    const skipped = { _execution: { applied: false, reason: "x" } };
    expect(isApprovedButNotApplied({ status: "approved", parameters: skipped })).toBe(true);
    expect(isApprovedButNotApplied({ status: "rejected", parameters: skipped })).toBe(false);
    expect(isApprovedButNotApplied({ status: "approved", parameters: { _execution: { applied: true } } })).toBe(false);
    expect(isApprovedButNotApplied({ status: "approved", parameters: null })).toBe(false);
  });
});

describe("row removal", () => {
  it("knows which rule types can remove rows", () => {
    expect(removesRows("filter")).toBe(true);
    expect(removesRows("drop_nulls")).toBe(true);
    expect(removesRows("deduplicate")).toBe(true);
    expect(removesRows("type_cast")).toBe(false);
    expect(removesRows("trim_whitespace")).toBe(false);
  });
  it("sums the rows each rule removed", () => {
    expect(rowsRemovedByRules([
      { parameters: { _execution: { applied: true, rows_removed: 4 } } },
      { parameters: { _execution: { applied: true, rows_removed: 1 } } },
      { parameters: { _execution: { applied: true } } },
      { parameters: null },
    ])).toBe(5);
    expect(rowsRemovedByRules([])).toBe(0);
  });
});

describe("badCellRowsByRules", () => {
  it("splits rows removed for one bad cell from rows the guard kept", () => {
    expect(badCellRowsByRules([
      { parameters: { _execution: { applied: true, rows_removed: 3, bad_cell_rows: 2 } } },
      { parameters: { _execution: { applied: false, reason: "guard: ...", rows_removed: 0, bad_cell_rows: 4 } } },
      { parameters: { _execution: { applied: true, rows_removed: 5 } } },
      { parameters: null },
    ])).toEqual({ removed: 2, kept: 4 });
    expect(badCellRowsByRules([])).toEqual({ removed: 0, kept: 0 });
  });
});
