import { describe, expect, it } from "vitest";
import { isApprovedButNotApplied, ruleExecution } from "@/lib/types";

describe("ruleExecution", () => {
  it("reads the executor's _execution record", () => {
    expect(ruleExecution({ _execution: { applied: false, reason: "cannot cast" } }))
      .toEqual({ applied: false, reason: "cannot cast" });
    expect(ruleExecution({ _execution: { applied: true } })).toEqual({ applied: true, reason: null });
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
