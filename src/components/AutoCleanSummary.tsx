"use client";

interface PassInfo {
  iteration: number;
  improvement: number | null;
  processedScore: number | null;
  rules: Array<{
    id: string;
    rule_type: string;
    column_name: string | null;
    status: string;
    ai_reasoning: string | null;
    parameters: Record<string, unknown> | null;
  }>;
}

interface Props {
  passes: PassInfo[];
}

export default function AutoCleanSummary({ passes }: Props) {
  if (!passes.length) return null;

  return (
    <div className="bg-gray-900 border border-indigo-500/20 rounded-xl p-6 space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-indigo-400 text-lg">⚡</span>
        <h2 className="text-white font-semibold text-lg">Auto-Clean Summary</h2>
        <span className="text-xs text-gray-500 ml-auto">
          {passes.length} automated {passes.length === 1 ? "pass" : "passes"} · AI committee reviewed all rules
        </span>
      </div>

      <div className="space-y-3">
        {passes.map((pass) => {
          const approved = pass.rules.filter((r) => r.status === "approved");
          const rejected = pass.rules.filter((r) => r.status === "rejected");

          return (
            <div key={pass.iteration} className="border border-gray-800 rounded-lg p-4 space-y-2">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-indigo-400/20 text-indigo-400">
                  Pass {pass.iteration}
                </span>
                {pass.improvement !== null && (
                  <span className={`text-sm font-semibold ${pass.improvement >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {pass.improvement >= 0 ? "+" : ""}{pass.improvement.toFixed(1)}%
                    {pass.processedScore != null && (
                      <span className="text-gray-500 font-normal"> (score: {pass.processedScore})</span>
                    )}
                  </span>
                )}
                <span className="text-xs text-gray-500 ml-auto">
                  {approved.length} applied · {rejected.length} rejected by committee
                </span>
              </div>

              {approved.length > 0 && (
                <div className="space-y-1">
                  {approved.map((r) => (
                    <div key={r.id} className="flex items-start gap-2 text-xs">
                      <span className="text-green-400 mt-0.5 flex-shrink-0">✓</span>
                      <span className="text-gray-300">
                        <span className="font-medium">{r.rule_type.replace(/_/g, " ")}</span>
                        {r.column_name && (
                          <code className="ml-1 text-indigo-300 bg-gray-800 px-1 rounded">{r.column_name}</code>
                        )}
                        {r.ai_reasoning && (
                          <span className="text-gray-500"> — {r.ai_reasoning}</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {rejected.length > 0 && (
                <div className="space-y-1 border-t border-gray-800 pt-2 mt-2">
                  {rejected.map((r) => {
                    const reasons: string[] = (r.parameters as Record<string, unknown> | null)?._reject_reasons as string[] ?? [];
                    return (
                      <div key={r.id} className="flex items-start gap-2 text-xs">
                        <span className="text-red-400 mt-0.5 flex-shrink-0">✗</span>
                        <span className="text-gray-500">
                          <span className="line-through">{r.rule_type.replace(/_/g, " ")}</span>
                          {r.column_name && (
                            <code className="ml-1 bg-gray-800 px-1 rounded">{r.column_name}</code>
                          )}
                          {reasons.length > 0 && (
                            <span className="block text-gray-600 pl-0 mt-0.5">
                              Committee: {reasons[0]}
                            </span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
