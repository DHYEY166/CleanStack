/**
 * Describes the deliverable a completed run produced, so the download route can
 * hand out a presigned S3 URL with the right filename and content type.
 * Pure helpers only (no AWS calls) so they are unit-testable.
 */

/** Presigned download URLs are short-lived: the browser follows them immediately. */
export const DOWNLOAD_URL_TTL_SECONDS = 120;

export const DELIVERABLE_CONTENT_TYPES: Record<string, string> = {
  csv: "text/csv",
  txt: "text/plain",
  tsv: "text/tab-separated-values",
  json: "application/json",
  jsonl: "application/x-ndjson",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export interface DeliverableDescriptor {
  /** Format of the bytes stored in S3 (what the executor actually wrote). */
  format: string;
  contentType: string;
  filename: string;
}

/**
 * The executor writes `processed/{pipeline}/{run}/output.<ext>`; the stored
 * extension is the source of truth (an `.xls` upload is delivered as `.xlsx`).
 * `file_format` is only a fallback for keys without an extension.
 */
export function deliverableFormat(
  processedKey: string | null | undefined,
  fileFormat: string | null | undefined,
): string {
  const base = processedKey?.split("/").pop() ?? "";
  const ext = base.includes(".") ? base.split(".").pop() : undefined;
  const fmt = (ext || fileFormat || "csv").toLowerCase();
  return fmt === "xls" ? "xlsx" : fmt;
}

export function describeDeliverable(
  runId: string,
  processedKey: string,
  fileFormat: string | null | undefined,
): DeliverableDescriptor {
  const format = deliverableFormat(processedKey, fileFormat);
  const contentType = DELIVERABLE_CONTENT_TYPES[format] ?? "application/octet-stream";
  const safeRun = runId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 8) || "run";
  const safeExt = format.replace(/[^a-z0-9]/g, "") || "bin";
  return { format, contentType, filename: `cleanstack_${safeRun}.${safeExt}` };
}

/** `Content-Disposition` value S3 should return for the presigned GET. */
export function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"`;
}
