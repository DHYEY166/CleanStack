"use client";

import { useState } from "react";
import * as XLSX from "xlsx";

type Format = "csv" | "tsv" | "json" | "jsonl" | "xlsx";

const FORMAT_OPTIONS: { value: Format; label: string }[] = [
  { value: "csv", label: "CSV" },
  { value: "tsv", label: "TSV" },
  { value: "xlsx", label: "Excel (XLSX)" },
  { value: "json", label: "JSON" },
  { value: "jsonl", label: "JSONL" },
];

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.replace(/^"|"$/g, "").trim());
  return lines.slice(1).map((line) => {
    const values: string[] = [];
    let cur = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === "," && !inQuote) { values.push(cur); cur = ""; }
      else { cur += ch; }
    }
    values.push(cur);
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""]));
  });
}

export default function DownloadButton({
  presignedUrl,
  inputFormat,
  runId,
}: {
  presignedUrl: string;
  inputFormat: string;
  runId: string;
}) {
  const defaultFmt = (FORMAT_OPTIONS.find((f) => f.value === inputFormat)?.value ?? "csv") as Format;
  const [fmt, setFmt] = useState<Format>(defaultFmt);
  const [loading, setLoading] = useState(false);

  async function handleDownload() {
    setLoading(true);
    try {
      const res = await fetch(presignedUrl);
      const csvText = await res.text();
      const rows = parseCSV(csvText);
      const filename = `cleanstack_${runId.slice(0, 8)}`;

      if (fmt === "csv") {
        const blob = new Blob([csvText], { type: "text/csv" });
        triggerDownload(blob, `${filename}.csv`);
      } else if (fmt === "tsv") {
        const headers = Object.keys(rows[0] ?? {});
        const tsv = [headers.join("\t"), ...rows.map((r) => headers.map((h) => r[h]).join("\t"))].join("\n");
        const blob = new Blob([tsv], { type: "text/tab-separated-values" });
        triggerDownload(blob, `${filename}.tsv`);
      } else if (fmt === "json") {
        const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
        triggerDownload(blob, `${filename}.json`);
      } else if (fmt === "jsonl") {
        const jsonl = rows.map((r) => JSON.stringify(r)).join("\n");
        const blob = new Blob([jsonl], { type: "application/jsonl" });
        triggerDownload(blob, `${filename}.jsonl`);
      } else if (fmt === "xlsx") {
        const ws = XLSX.utils.json_to_sheet(rows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Cleaned Data");
        const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
        const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        triggerDownload(blob, `${filename}.xlsx`);
      }
    } finally {
      setLoading(false);
    }
  }

  function triggerDownload(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex items-center gap-2">
      <select
        value={fmt}
        onChange={(e) => setFmt(e.target.value as Format)}
        className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
      >
        {FORMAT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        onClick={handleDownload}
        disabled={loading}
        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors"
      >
        {loading ? "Preparing…" : "↓ Download Clean Data"}
      </button>
    </div>
  );
}
