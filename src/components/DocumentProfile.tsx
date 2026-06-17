type PiiCounts = {
  emails: number;
  phones: number;
  ssns: number;
  credit_cards: number;
};

type DocumentStats = {
  word_count?: number;
  char_count?: number;
  blank_line_count?: number;
  pii_detected?: PiiCounts;
  html_tag_count?: number;
  sample_text?: string;
};

export default function DocumentProfile({
  qualityScore,
  totalLines,
  columnStats,
}: {
  qualityScore: number;
  totalLines: number;
  columnStats: Record<string, unknown>;
}) {
  const stats = columnStats as unknown as DocumentStats;
  const pii = stats?.pii_detected;
  const totalPii = (pii?.emails ?? 0) + (pii?.phones ?? 0) + (pii?.ssns ?? 0) + (pii?.credit_cards ?? 0);

  const scoreColor =
    qualityScore >= 80 ? "text-green-400" :
    qualityScore >= 60 ? "text-yellow-400" : "text-red-400";

  return (
    <div className="space-y-4">
      {/* Score + stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-gray-800 rounded-xl p-4 text-center">
          <p className="text-gray-400 text-xs mb-1">Quality Score</p>
          <p className={`text-3xl font-bold ${scoreColor}`}>{qualityScore}</p>
        </div>
        <div className="bg-gray-800 rounded-xl p-4 text-center">
          <p className="text-gray-400 text-xs mb-1">Lines</p>
          <p className="text-2xl font-bold text-white">{totalLines.toLocaleString()}</p>
        </div>
        <div className="bg-gray-800 rounded-xl p-4 text-center">
          <p className="text-gray-400 text-xs mb-1">Words</p>
          <p className="text-2xl font-bold text-white">
            {stats?.word_count?.toLocaleString() ?? "—"}
          </p>
        </div>
        <div className="bg-gray-800 rounded-xl p-4 text-center">
          <p className="text-gray-400 text-xs mb-1">Characters</p>
          <p className="text-2xl font-bold text-white">
            {stats?.char_count?.toLocaleString() ?? "—"}
          </p>
        </div>
      </div>

      {/* Issues detected */}
      <div className="bg-gray-800 rounded-xl p-5">
        <h3 className="text-white font-semibold mb-3">Issues Detected</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
          <IssueRow
            label="Emails (PII)"
            count={pii?.emails ?? 0}
            severity="high"
          />
          <IssueRow
            label="Phone numbers (PII)"
            count={pii?.phones ?? 0}
            severity="high"
          />
          <IssueRow
            label="SSNs (PII)"
            count={pii?.ssns ?? 0}
            severity="high"
          />
          <IssueRow
            label="Credit cards (PII)"
            count={pii?.credit_cards ?? 0}
            severity="high"
          />
          <IssueRow
            label="HTML tags"
            count={stats?.html_tag_count ?? 0}
            severity="medium"
          />
          <IssueRow
            label="Blank lines"
            count={stats?.blank_line_count ?? 0}
            severity="low"
          />
        </div>

        {totalPii > 0 && (
          <div className="mt-3 flex items-center gap-2 bg-red-900/30 border border-red-700/40 rounded-lg px-3 py-2">
            <span className="text-red-400 text-xs font-medium">
              {totalPii} PII instance{totalPii !== 1 ? "s" : ""} detected — AI will suggest redaction rules
            </span>
          </div>
        )}
      </div>

      {/* Sample text */}
      {stats?.sample_text && (
        <div className="bg-gray-800 rounded-xl p-5">
          <h3 className="text-white font-semibold mb-2">Document Sample</h3>
          <pre className="text-gray-300 text-xs whitespace-pre-wrap font-mono leading-relaxed max-h-40 overflow-y-auto">
            {stats.sample_text}
          </pre>
        </div>
      )}
    </div>
  );
}

function IssueRow({
  label, count, severity,
}: {
  label: string;
  count: number;
  severity: "high" | "medium" | "low";
}) {
  const dot =
    count === 0 ? "bg-green-500" :
    severity === "high" ? "bg-red-500" :
    severity === "medium" ? "bg-yellow-500" : "bg-blue-400";

  return (
    <div className="flex items-center justify-between bg-gray-700/50 rounded-lg px-3 py-2">
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
        <span className="text-gray-300 text-xs">{label}</span>
      </div>
      <span className={`font-mono text-sm font-semibold ${count > 0 ? "text-white" : "text-gray-500"}`}>
        {count}
      </span>
    </div>
  );
}
