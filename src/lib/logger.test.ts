import { afterEach, describe, expect, it } from "vitest";
import { createLogger, serializeError, type LogLevel } from "@/lib/logger";

function capture() {
  const lines: { level: LogLevel; obj: Record<string, unknown> }[] = [];
  const log = createLogger({ service: "test" }, (level, line) => lines.push({ level, obj: JSON.parse(line) }));
  return { log, lines };
}

afterEach(() => { delete process.env.LOG_LEVEL; });

describe("logger", () => {
  it("writes one JSON object with ts, level, msg, context and fields", () => {
    const { log, lines } = capture();
    log.child({ route: "POST /api/x" }).info("done", { run_id: "r1", n: 2 });
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("info");
    expect(lines[0].obj).toMatchObject({ level: "info", msg: "done", service: "test", route: "POST /api/x", run_id: "r1", n: 2 });
    expect(typeof lines[0].obj.ts).toBe("string");
  });

  it("serialises errors instead of dropping them", () => {
    const { log, lines } = capture();
    const err = Object.assign(new Error("boom"), { code: "E1", $metadata: { httpStatusCode: 503 } });
    log.error("failed", { err });
    expect(lines[0].obj.err).toMatchObject({ name: "Error", message: "boom", code: "E1", httpStatusCode: 503 });
    expect(String((lines[0].obj.err as { stack: string }).stack)).toContain("boom");
  });

  it("redacts credential-like keys at any depth", () => {
    const { log, lines } = capture();
    log.warn("req", { headers: { authorization: "Bearer x", "x-webhook-secret": "s" }, apiKey: "k", ok: 1 });
    expect(lines[0].obj).toMatchObject({
      headers: { authorization: "[REDACTED]", "x-webhook-secret": "[REDACTED]" }, apiKey: "[REDACTED]", ok: 1,
    });
  });

  it("survives circular structures and bigint", () => {
    const { log, lines } = capture();
    const a: Record<string, unknown> = { n: BigInt(5) };
    a.self = a;
    log.info("c", { a });
    expect(lines[0].obj.a).toEqual({ n: "5", self: "[Circular]" });
  });

  it("honours LOG_LEVEL", () => {
    const { log, lines } = capture();
    log.debug("hidden");
    process.env.LOG_LEVEL = "error";
    log.warn("hidden too");
    log.error("shown");
    expect(lines.map((l) => l.obj.msg)).toEqual(["shown"]);
  });

  it("serializeError handles non-Error values", () => {
    expect(serializeError("x")).toEqual({ message: "x" });
  });
});
