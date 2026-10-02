import * as XLSX from "@e965/xlsx";
import { stripSidecarKeys } from "@/lib/sidecar";

export type TrainingFormat = "raw_jsonl" | "alpaca" | "chat";

/**
 * Parse a run's deliverable into records for training export.
 *
 * - Values are taken exactly as the executor wrote them: delimited text is read
 *   with `raw: true` so cleaned strings such as "00123" or "2024-01-02" are not
 *   re-typed into 123 or an Excel date serial.
 * - TSV goes through the same quote-aware parser as CSV (a quoted field may
 *   contain a tab).
 * - `__orig_*` audit keys are always dropped, so pre-transform values never
 *   reach a training file, even for deliverables written by older executors.
 */
export function parseDeliverableRows(bytes: Buffer, fmt: string): Record<string, unknown>[] {
  let rows: Record<string, unknown>[];
  if (fmt === "json") {
    const parsed = JSON.parse(bytes.toString("utf-8"));
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } else if (fmt === "jsonl") {
    rows = bytes
      .toString("utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } else if (fmt === "xlsx" || fmt === "xls") {
    const wb = XLSX.read(bytes, { type: "buffer", cellDates: true });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]) as Record<string, unknown>[];
  } else {
    // csv / tsv / txt
    const text = bytes.toString("utf-8");
    const wb = XLSX.read(text, { type: "string", raw: true, FS: fmt === "tsv" ? "\t" : "," });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]) as Record<string, unknown>[];
  }
  return rows.map((r) => (r && typeof r === "object" && !Array.isArray(r) ? stripSidecarKeys(r) : r));
}

export function toTrainingFormat(rows: Record<string, unknown>[], fmt: TrainingFormat): string {
  if (fmt === "alpaca") {
    return rows.map((row) => JSON.stringify({
      instruction: "Process and analyze this data record.",
      input: JSON.stringify(row),
      output: "",
    })).join("\n");
  }
  if (fmt === "chat") {
    return rows.map((row) => JSON.stringify({
      messages: [
        { role: "user", content: JSON.stringify(row) },
        { role: "assistant", content: "" },
      ],
    })).join("\n");
  }
  return rows.map((row) => JSON.stringify(row)).join("\n");
}
