"use client";

import { useState } from "react";
import { removesRows, type TransformRule } from "@/lib/types";
import { ruleGuardOf } from "@/lib/rule-guard";

type Decision = "approved" | "rejected";

export interface RuleDecision {
  rule_id: string;
  action: Decision;
  modifications: Record<string, unknown> | null;
}

interface RuleCardProps {
  rule: TransformRule;
  onChange: (decision: RuleDecision) => void;
}

export default function RuleCard({ rule, onChange }: RuleCardProps) {
  const [decision, setDecision] = useState<Decision | null>(null);
  const [editing, setEditing] = useState(false);
  const [params, setParams] = useState<string>(
    JSON.stringify(rule.parameters ?? {}, null, 2)
  );
  const [paramsError, setParamsError] = useState<string | null>(null);

  function decide(action: Decision, mods: Record<string, unknown> | null = null) {
    setDecision(action);
    setEditing(false);
    onChange({ rule_id: rule.id, action, modifications: mods });
  }

  function submitEdit() {
    try {
      const parsed = JSON.parse(params);
      setParamsError(null);
      decide("approved", parsed);
    } catch {
      setParamsError("Invalid JSON");
    }
  }

  const guard = ruleGuardOf(rule.parameters);
  // Internal keys (_guard, _execution, ...) are not user parameters.
  const visibleParams = Object.entries(rule.parameters ?? {}).filter(([k]) => !k.startsWith("_"));

  const borderColor =
    decision === "approved"
      ? "border-green-500/50"
      : decision === "rejected"
      ? "border-red-500/30"
      : "border-gray-800";

  const bgColor =
    decision === "approved"
      ? "bg-green-500/5"
      : decision === "rejected"
      ? "bg-red-500/5"
      : "bg-gray-900";

  return (
    <div className={`rounded-xl border p-4 transition-colors ${borderColor} ${bgColor}`}>
      <div className="flex items-start gap-4">
        {/* Rule info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-white text-sm font-medium">
              {rule.rule_type.replace(/_/g, " ")}
            </span>
            {rule.column_name && (
              <code className="text-xs bg-gray-800 text-indigo-300 px-2 py-0.5 rounded">
                {rule.column_name}
              </code>
            )}
            {removesRows(rule.rule_type) && (
              <span
                className="text-xs px-2 py-0.5 rounded-full font-medium bg-amber-400/10 text-amber-300"
                title="This rule deletes whole rows from the output. The run page shows how many it removed."
              >
                removes rows
              </span>
            )}
            {decision && (
              <span
                className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  decision === "approved"
                    ? "bg-green-400/10 text-green-400"
                    : "bg-red-400/10 text-red-400"
                }`}
              >
                {decision}
              </span>
            )}
          </div>

          {rule.ai_reasoning && (
            <p className="text-gray-400 text-xs mb-2">{rule.ai_reasoning}</p>
          )}

          {guard && (
            <div
              role="alert"
              className="mb-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
            >
              <span className="font-medium text-amber-300">Removes rows because of one bad cell. </span>
              {guard.reason} Not included in &quot;Approve all&quot;; approve it on its own if you really want these rows gone.
            </div>
          )}

          {/* Inline params editor */}
          {editing && (
            <div className="mt-2">
              <textarea
                value={params}
                onChange={(e) => setParams(e.target.value)}
                rows={4}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg p-2 text-xs text-gray-200 font-mono focus:outline-none focus:border-indigo-500"
              />
              {paramsError && (
                <p className="text-red-400 text-xs mt-1">{paramsError}</p>
              )}
              <div className="flex gap-2 mt-2">
                <button
                  onClick={submitEdit}
                  className="text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1 rounded transition-colors"
                >
                  Save & Approve
                </button>
                <button
                  onClick={() => { setEditing(false); setParamsError(null); }}
                  className="text-xs text-gray-400 hover:text-gray-200 px-3 py-1 rounded transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {!editing && visibleParams.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {visibleParams.map(([k, v]) => (
                <span
                  key={k}
                  className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded"
                >
                  {k}: {String(v)}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Action buttons */}
        {!editing && (
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={() => decide("approved")}
              title="Approve"
              className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm transition-colors ${
                decision === "approved"
                  ? "bg-green-500 text-white"
                  : "bg-gray-800 hover:bg-green-500/20 text-gray-400 hover:text-green-400"
              }`}
            >
              ✓
            </button>
            <button
              onClick={() => setEditing(true)}
              title="Edit params"
              className="w-8 h-8 rounded-lg flex items-center justify-center text-sm bg-gray-800 hover:bg-indigo-500/20 text-gray-400 hover:text-indigo-400 transition-colors"
            >
              ✎
            </button>
            <button
              onClick={() => decide("rejected")}
              title="Reject"
              className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm transition-colors ${
                decision === "rejected"
                  ? "bg-red-500 text-white"
                  : "bg-gray-800 hover:bg-red-500/20 text-gray-400 hover:text-red-400"
              }`}
            >
              ✗
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
