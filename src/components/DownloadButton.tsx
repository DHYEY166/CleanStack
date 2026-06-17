"use client";

import { useState } from "react";
import * as XLSX from "xlsx";

type Format = "csv" | "tsv" | "txt" | "json" | "jsonl" | "xlsx" | "xml";

const FORMAT_LABELS: Record<string, string> = {
  csv:   "CSV",
  tsv:   "TSV",
  json:  "JSON",
  jsonl: "JSONL",
  xlsx:  "Excel (XLSX)",
  xls:   "Excel (XLSX)",
  xml:   "XML",
  txt:   "TXT",
};

const EXPORT_OPTIONS: { value: Format; label: string }[] = [
  { value: "csv",   label: "CSV" },
  { value: "tsv",   label: "TSV" },
  { value: "json",  label: "JSON" },
  { value: "jsonl", label: "JSONL" },
  { value: "xlsx",  label: "Excel (XLSX)" },
];

function nativeExt(fmt: string): Format {
  if (fmt === "xls") return "xlsx";
  return (fmt as Format) || "csv";
}

function triggerDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function bufferToRecords(buf: ArrayBuffer, fmt: string): Promise<Record<string, unknown>[]> {
  const text = new TextDecoder().decode(buf);

  if (fmt === "json") {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    const listVal = Object.values(parsed as Record<string, unknown>).find(Array.isArray);
    return (listVal as Record<string, unknown>[]) ?? [parsed as Record<string, unknown>];
  }

  if (fmt === "jsonl") {
    return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  if (fmt === "xml") {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const records = Array.from(doc.querySelectorAll("record"));
    return records.map((rec) => {
      const obj: Record<string, unknown> = {};
      rec.childNodes.forEach((child) => {
        if (child.nodeType === Node.ELEMENT_NODE) {
          obj[(child as Element).tagName] = child.textContent;
        }
      });
      return obj;
    });
  }

  if (fmt === "xlsx" || fmt === "xls") {
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json<Record<string, unknown>>(ws);
  }

  // csv / tsv / txt
  const sep = fmt === "tsv" ? "\t" : ",";
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(sep).map((h) => h.replace(/^"|"$/g, "").trim());
  return lines.slice(1).map((line) => {
    const values: string[] = [];
    let cur = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === sep && !inQuote) { values.push(cur); cur = ""; }
      else { cur += ch; }
    }
    values.push(cur);
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""]));
  });
}

function recordsToBlob(rows: Record<string, unknown>[], fmt: Format): { blob: Blob; ext: string } {
  const headers = Object.keys(rows[0] ?? {});

  if (fmt === "json") {
    return {
      blob: new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" }),
      ext: "json",
    };
  }
  if (fmt === "jsonl") {
    const text = rows.map((r) => JSON.stringify(r)).join("\n");
    return { blob: new Blob([text], { type: "application/x-ndjson" }), ext: "jsonl" };
  }
  if (fmt === "tsv") {
    const tsv = [
      headers.join("\t"),
      ...rows.map((r) => headers.map((h) => String(r[h] ?? "")).join("\t")),
    ].join("\n");
    return { blob: new Blob([tsv], { type: "text/tab-separated-values" }), ext: "tsv" };
  }
  if (fmt === "xlsx") {
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Cleaned Data");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    return {
      blob: new Blob([buf], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      ext: "xlsx",
    };
  }
  // default: csv
  const csv = [
    headers.join(","),
    ...rows.map((r) =>
      headers.map((h) => {
        const v = String(r[h] ?? "");
        return v.includes(",") || v.includes('"') || v.includes("\n")
          ? `"${v.replace(/"/g, '""')}"` : v;
      }).join(",")
    ),
  ].join("\n");
  return { blob: new Blob([csv], { type: "text/csv" }), ext: "csv" };
}

export default function DownloadButton({
  runId,
  inputFormat,
  mode = "tabular",
}: {
  runId: string;
  inputFormat: string;
  mode?: string;
}) {
  const isDocument = mode === "document";
  const native = isDocument ? "txt" : nativeExt(inputFormat);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportFmt, setExportFmt] = useState<Format>("csv");
  const [showExport, setShowExport] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filename = `cleanstack_${runId.slice(0, 8)}`;

  async function handleNativeDownload() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/download/${runId}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const buf = await res.arrayBuffer();
      const mimes: Record<Format, string> = {
        csv:   "text/csv",
        txt:   "text/plain",
        tsv:   "text/tab-separated-values",
        json:  "application/json",
        jsonl: "application/x-ndjson",
        xlsx:  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        xml:   "application/xml",
      };
      triggerDownload(new Blob([buf], { type: mimes[native] }), `${filename}.${native}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleExport() {
    setExporting(true);
    setError(null);
    try {
      const res = await fetch(`/api/download/${runId}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const buf = await res.arrayBuffer();
      const rows = await bufferToRecords(buf, inputFormat);
      const { blob, ext } = recordsToBlob(rows, exportFmt);
      triggerDownload(blob, `${filename}.${ext}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  const nativeLabel = isDocument ? "TXT" : (FORMAT_LABELS[inputFormat] ?? inputFormat.toUpperCase());
  const exportOptions = EXPORT_OPTIONS.filter((o) => o.value !== native);

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        {/* Primary: native format download */}
        <button
          onClick={handleNativeDownload}
          disabled={loading}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {loading ? "Preparing…" : `↓ Download ${nativeLabel}`}
        </button>

        {/* Secondary: export as different format — hidden for document mode */}
        {!isDocument && (
          <button
            onClick={() => setShowExport((v) => !v)}
            className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition-colors"
          >
            Export As ▾
          </button>
        )}
      </div>

      {showExport && (
        <div className="flex items-center gap-2">
          <select
            value={exportFmt}
            onChange={(e) => setExportFmt(e.target.value as Format)}
            className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
          >
            {exportOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            onClick={handleExport}
            disabled={exporting}
            className="px-4 py-2 bg-gray-600 hover:bg-gray-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {exporting ? "Converting…" : "↓ Export"}
          </button>
        </div>
      )}

      {error && <p className="text-red-400 text-xs">{error}</p>}
    </div>
  );
}
