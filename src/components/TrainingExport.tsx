"use client";

import { useState } from "react";

type TrainingFormat = "raw_jsonl" | "alpaca" | "chat";
type SplitRatio = "none" | "80-10-10" | "70-15-15" | "60-20-20";
type SplitTarget = "all" | "train" | "val" | "test";

const FORMAT_OPTIONS: { value: TrainingFormat; label: string; desc: string }[] = [
  { value: "raw_jsonl", label: "Raw JSONL",     desc: "One JSON object per row — universal format" },
  { value: "alpaca",    label: "Alpaca",         desc: "instruction / input / output — LLM fine-tuning" },
  { value: "chat",      label: "Chat (OpenAI)",  desc: "messages array — OpenAI fine-tune format" },
];

const SPLIT_OPTIONS: { value: SplitRatio; label: string }[] = [
  { value: "none",      label: "No split (full dataset)" },
  { value: "80-10-10",  label: "80 / 10 / 10" },
  { value: "70-15-15",  label: "70 / 15 / 15" },
  { value: "60-20-20",  label: "60 / 20 / 20" },
];

interface Props {
  runId: string;
}

export default function TrainingExport({ runId }: Props) {
  const [format, setFormat]       = useState<TrainingFormat>("raw_jsonl");
  const [split, setSplit]         = useState<SplitRatio>("none");
  const [downloading, setDownloading] = useState<SplitTarget | null>(null);
  const [error, setError]         = useState<string | null>(null);

  const hasSplit = split !== "none";

  async function download(target: SplitTarget) {
    setDownloading(target);
    setError(null);
    try {
      const url = `/api/export-training/${runId}?format=${format}&split=${split}&target=${target}`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Download failed" }));
        setError(body.error ?? "Download failed");
        return;
      }
      const blob = await res.blob();
      const cd   = res.headers.get("Content-Disposition") ?? "";
      const match = cd.match(/filename="([^"]+)"/);
      const filename = match ? match[1] : `training_${runId.slice(0, 8)}.jsonl`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div className="bg-gray-900 border border-indigo-500/20 rounded-xl p-6">
      <div className="flex items-center gap-2 mb-5">
        <div className="w-2 h-2 rounded-full bg-indigo-400" />
        <h2 className="text-lg font-semibold text-white">Export for AI Training</h2>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-6">
        {/* Format */}
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wider mb-3">Training Format</p>
          <div className="space-y-2">
            {FORMAT_OPTIONS.map((o) => (
              <label
                key={o.value}
                className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  format === o.value
                    ? "border-indigo-500/60 bg-indigo-500/10"
                    : "border-gray-800 hover:border-gray-700"
                }`}
              >
                <input
                  type="radio"
                  name="trainingFormat"
                  value={o.value}
                  checked={format === o.value}
                  onChange={() => setFormat(o.value)}
                  className="mt-0.5 accent-indigo-500"
                />
                <div>
                  <div className="text-white text-sm font-medium">{o.label}</div>
                  <div className="text-gray-500 text-xs mt-0.5">{o.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Split */}
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wider mb-3">Train / Val / Test Split</p>
          <div className="space-y-2">
            {SPLIT_OPTIONS.map((o) => (
              <label
                key={o.value}
                className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  split === o.value
                    ? "border-indigo-500/60 bg-indigo-500/10"
                    : "border-gray-800 hover:border-gray-700"
                }`}
              >
                <input
                  type="radio"
                  name="splitRatio"
                  value={o.value}
                  checked={split === o.value}
                  onChange={() => setSplit(o.value)}
                  className="accent-indigo-500"
                />
                <span className="text-white text-sm">{o.label}</span>
              </label>
            ))}
          </div>

          {hasSplit && (
            <p className="text-gray-600 text-xs mt-3">
              Split is seeded by run ID — reproducible every download.
            </p>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-4 text-red-400 text-sm bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-2">
          {error}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Btn
          label={hasSplit ? "↓ All Splits (with _split col)" : "↓ Download Full Dataset"}
          target="all"
          downloading={downloading}
          onClick={() => download("all")}
          primary
        />
        {hasSplit && (
          <>
            <Btn label="↓ Train"  target="train" downloading={downloading} onClick={() => download("train")} />
            <Btn label="↓ Val"    target="val"   downloading={downloading} onClick={() => download("val")} />
            <Btn label="↓ Test"   target="test"  downloading={downloading} onClick={() => download("test")} />
          </>
        )}
      </div>

      <p className="text-gray-600 text-xs mt-3">
        Output: JSONL · Tabular formats only (CSV, JSON, XLSX, TSV, JSONL)
      </p>
    </div>
  );
}

function Btn({
  label, target, downloading, onClick, primary = false,
}: {
  label: string;
  target: SplitTarget;
  downloading: SplitTarget | null;
  onClick: () => void;
  primary?: boolean;
}) {
  const loading = downloading === target;
  return (
    <button
      onClick={onClick}
      disabled={downloading !== null}
      className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
        primary
          ? "bg-indigo-600 hover:bg-indigo-500 text-white"
          : "bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700"
      }`}
    >
      {loading ? (
        <>
          <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          Preparing…
        </>
      ) : (
        label
      )}
    </button>
  );
}
