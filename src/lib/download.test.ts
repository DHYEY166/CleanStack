import { describe, expect, it } from "vitest";
import {
  DELIVERABLE_CONTENT_TYPES,
  DOWNLOAD_URL_TTL_SECONDS,
  attachmentDisposition,
  deliverableFormat,
  describeDeliverable,
} from "@/lib/download";

describe("deliverableFormat", () => {
  it("uses the extension of the stored key", () => {
    expect(deliverableFormat("processed/p/r/output.json", "csv")).toBe("json");
  });
  it("delivers xls uploads as xlsx", () => {
    expect(deliverableFormat("processed/p/r/output.xlsx", "xls")).toBe("xlsx");
    expect(deliverableFormat("processed/p/r/output", "xls")).toBe("xlsx");
  });
  it("falls back to file_format, then csv", () => {
    expect(deliverableFormat("processed/p/r/output", "tsv")).toBe("tsv");
    expect(deliverableFormat(null, null)).toBe("csv");
  });
});

describe("describeDeliverable", () => {
  it("builds filename and content type", () => {
    const d = describeDeliverable("0123abcd-ffff-4444", "processed/p/r/output.csv", "csv");
    expect(d).toEqual({ format: "csv", contentType: "text/csv", filename: "cleanstack_0123abcd.csv" });
  });
  it("uses octet-stream for unknown formats", () => {
    expect(describeDeliverable("abc", "processed/p/r/output.weird", null).contentType)
      .toBe("application/octet-stream");
  });
  it("cannot inject header characters through runId", () => {
    const d = describeDeliverable('a"\r\nX: y', "processed/p/r/output.csv", "csv");
    expect(d.filename).not.toMatch(/["\r\n:]/);
  });
  it("covers every executor output format", () => {
    for (const f of ["csv", "tsv", "json", "jsonl", "xlsx", "xml", "txt", "pdf", "docx"]) {
      expect(DELIVERABLE_CONTENT_TYPES[f]).toBeTruthy();
    }
  });
});

describe("attachmentDisposition", () => {
  it("quotes the filename and strips unsafe characters", () => {
    expect(attachmentDisposition("cleanstack_1.csv")).toBe('attachment; filename="cleanstack_1.csv"');
    expect(attachmentDisposition('a"b\\é.csv')).toBe('attachment; filename="a_b__.csv"');
  });
  it("keeps the URL short-lived", () => {
    expect(DOWNLOAD_URL_TTL_SECONDS).toBeLessThanOrEqual(300);
  });
});
