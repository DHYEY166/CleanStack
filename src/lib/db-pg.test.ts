import { afterEach, describe, expect, it, vi } from "vitest";
import { dataApiTypes, shapeRow, toPgQuery } from "@/lib/db-pg";

describe("toPgQuery", () => {
  it("keeps positional params and serialises objects and dates", () => {
    const d = new Date("2026-01-02T03:04:05.000Z");
    expect(toPgQuery("SELECT $1, $2, $3, $4", ["a", { k: 1 }, d, undefined])).toEqual({
      text: "SELECT $1, $2, $3, $4",
      values: ["a", '{"k":1}', "2026-01-02T03:04:05.000Z", null],
    });
  });
  it("expands arrays like the Data API path and drops the orphaned array cast", () => {
    expect(toPgQuery("WHERE id IN $1::uuid[] AND x = $2", [["a", "b"], 7])).toEqual({
      text: "WHERE id IN ($1, $2) AND x = $3",
      values: ["a", "b", 7],
    });
  });
});

describe("result shaping", () => {
  const parse = (oid: number, raw: string) =>
    (dataApiTypes as unknown as { getTypeParser: (o: number) => (r: string) => unknown }).getTypeParser(oid)(raw);
  it("returns Data API shapes", () => {
    expect(parse(16, "t")).toBe(true);
    expect(parse(20, "42")).toBe(42);           // bigint -> longValue
    expect(parse(1700, "12.50")).toBe("12.50"); // numeric -> stringValue
    expect(parse(1184, "2026-01-02 03:04:05.123+00")).toBe("2026-01-02 03:04:05.123");
    expect(shapeRow({ j: '{"a":1}', t: "[REDACTED]", n: 1 })).toEqual({ j: { a: 1 }, t: "[REDACTED]", n: 1 });
  });
});

describe("db.ts driver gate", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
  it("refuses DB_DRIVER=pg outside test mode (never reaches the database)", async () => {
    vi.stubEnv("DB_DRIVER", "pg");
    vi.stubEnv("CLEANSTACK_TEST_MODE", "");
    const { query } = await import("@/lib/db");
    await expect(query("SELECT 1")).rejects.toThrow(/only allowed in test mode/);
  });
  it("refuses DB_DRIVER=pg on Vercel even with the test flag", async () => {
    vi.stubEnv("DB_DRIVER", "pg");
    vi.stubEnv("CLEANSTACK_TEST_MODE", "1");
    vi.stubEnv("VERCEL", "1");
    const { query } = await import("@/lib/db");
    await expect(query("SELECT 1")).rejects.toThrow(/only allowed in test mode/);
  });
});
