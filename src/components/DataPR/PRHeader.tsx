"use client";

interface PRHeaderProps {
  pipelineName: string;
  runId: string;
  total: number;
  approved: number;
  rejected: number;
  submitting: boolean;
  onSubmit: () => void;
}

export default function PRHeader({
  pipelineName,
  runId,
  total,
  approved,
  rejected,
  submitting,
  onSubmit,
}: PRHeaderProps) {
  const pending = total - approved - rejected;
  const allActioned = pending === 0;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs bg-indigo-500/20 text-indigo-400 px-2 py-0.5 rounded-full font-medium">
              Data PR
            </span>
            <span className="text-gray-500 text-xs font-mono">{runId.slice(0, 8)}</span>
          </div>
          <h1 className="text-xl font-semibold text-white">{pipelineName}</h1>
          <p className="text-gray-400 text-sm mt-1">
            Review AI-suggested transform rules before execution
          </p>
        </div>

        <button
          onClick={onSubmit}
          disabled={!allActioned || submitting}
          className={`px-5 py-2.5 rounded-lg font-medium text-sm transition-colors ${
            allActioned && !submitting
              ? "bg-indigo-600 hover:bg-indigo-500 text-white"
              : "bg-gray-800 text-gray-500 cursor-not-allowed"
          }`}
        >
          {submitting ? "Submitting…" : "Submit Review →"}
        </button>
      </div>

      <div className="flex items-center gap-4 mt-4 text-sm">
        <span className="text-gray-400">
          <span className="text-white font-medium">{total}</span> rules suggested
        </span>
        <span className="text-gray-600">·</span>
        <span className="text-green-400">
          <span className="font-medium">{approved}</span> approved
        </span>
        <span className="text-gray-600">·</span>
        <span className="text-red-400">
          <span className="font-medium">{rejected}</span> rejected
        </span>
        {pending > 0 && (
          <>
            <span className="text-gray-600">·</span>
            <span className="text-yellow-400">
              <span className="font-medium">{pending}</span> pending
            </span>
          </>
        )}
      </div>
    </div>
  );
}
