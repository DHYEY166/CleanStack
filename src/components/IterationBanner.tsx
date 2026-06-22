"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  runId: string;
  pipelineId: string;
  iteration: number;
  improvement: number | null;
  processedScore: number | null;
  autoMode?: boolean;
}

export default function IterationBanner({
  runId,
  pipelineId,
  iteration,
  improvement,
  processedScore,
  autoMode = false,
}: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const maxPasses = 3;
  const atCap = iteration >= maxPasses;
  const diminishing = improvement !== null && improvement < 5;
  const regressed = improvement !== null && improvement < 0;

  async function handleAutoClean() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/auto-clean`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to start auto-clean");
      router.push(`/pipelines/${pipelineId}/runs/${data.run_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }

  const improvementLine =
    improvement !== null
      ? regressed
        ? `Quality decreased ${Math.abs(improvement).toFixed(1)}% — rules may have over-filtered.`
        : `Pass ${iteration} improved quality by ${improvement.toFixed(1)}%${processedScore != null ? ` (score now ${processedScore})` : ""}.`
      : null;

  const recommendationLine = regressed
    ? "Do not run another pass."
    : atCap
    ? "Maximum 3 passes reached. Export your cleaned data below."
    : diminishing
    ? "Diminishing returns — further passes unlikely to help."
    : autoMode
    ? "AI committee validated this pass. Further passes will also be auto-validated."
    : "Run remaining passes automatically — AI committee reviews each rule.";

  const showButton = !atCap && !regressed && !autoMode;

  return (
    <div
      className={`border rounded-xl p-5 flex items-start justify-between gap-4 flex-wrap ${
        regressed
          ? "bg-red-500/10 border-red-500/30"
          : diminishing || atCap
          ? "bg-yellow-500/10 border-yellow-500/30"
          : "bg-indigo-500/10 border-indigo-500/30"
      }`}
    >
      <div className="space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`text-xs font-medium px-2 py-0.5 rounded-full ${
              regressed
                ? "bg-red-400/20 text-red-400"
                : diminishing || atCap
                ? "bg-yellow-400/20 text-yellow-400"
                : "bg-indigo-400/20 text-indigo-400"
            }`}
          >
            Pass {iteration} of {maxPasses}
          </span>
          {autoMode && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-purple-400/20 text-purple-400">
              <span aria-hidden="true">⚡</span> Auto-cleaned
            </span>
          )}
        </div>
        {improvementLine && (
          <p className="text-white text-sm font-medium">{improvementLine}</p>
        )}
        <p
          className={`text-sm ${
            regressed
              ? "text-red-400"
              : diminishing || atCap
              ? "text-yellow-400"
              : "text-gray-400"
          }`}
        >
          {recommendationLine}
        </p>
        {error && <p className="text-red-400 text-xs mt-1">{error}</p>}
      </div>

      {showButton && (
        <button
          onClick={handleAutoClean}
          disabled={loading}
          className="px-4 py-2 rounded-lg text-sm font-medium transition-colors flex-shrink-0 bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? "Starting…" : <><span aria-hidden="true">⚡</span> Auto-Clean Remaining →</>}
        </button>
      )}
    </div>
  );
}
