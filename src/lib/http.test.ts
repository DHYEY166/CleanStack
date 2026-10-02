import { describe, expect, it } from "vitest";
import { ApiError, readJson } from "@/lib/http";

const res = (body: string | null, status: number, statusText = "") =>
  new Response(body, { status, statusText, headers: body?.startsWith("{") ? { "content-type": "application/json" } : {} });

describe("readJson", () => {
  it("returns the parsed body on success", async () => {
    expect(await readJson(res('{"run_id":"r1"}', 200), "Upload")).toEqual({ run_id: "r1" });
  });

  it("reports an empty 500 with its status instead of a JSON parse error", async () => {
    const err = await readJson(res(null, 500, "Internal Server Error"), "Upload").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("Upload failed (HTTP 500 Internal Server Error): the server returned an empty response");
    expect(err.status).toBe(500);
  });

  it("uses the server's { error } message", async () => {
    await expect(readJson(res('{"error":"Monthly row limit reached"}', 402), "Upload"))
      .rejects.toThrow("Upload failed (HTTP 402): Monthly row limit reached");
  });

  it("summarises an HTML error page", async () => {
    await expect(readJson(res("<html><body><h1>413 Request Entity Too Large</h1></body></html>", 413), "Upload"))
      .rejects.toThrow("Upload failed (HTTP 413): 413 Request Entity Too Large");
  });

  it("rejects a 200 that is not JSON", async () => {
    await expect(readJson(res("", 200), "Create pipeline")).rejects.toThrow("Create pipeline failed (HTTP 200): the server returned an empty response");
  });
});
