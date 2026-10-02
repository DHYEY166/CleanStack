/** The test-only pg driver returns what the app's Data API code expects, against real Postgres. */
import { afterAll, describe, expect, it } from "vitest";
import { query, queryOne, withTransaction } from "@/lib/db";
import { closePgPool } from "@/lib/db-pg";

afterAll(() => closePgPool());

describe("DB_DRIVER=pg against Postgres", () => {
  it("shapes scalars like the Data API", async () => {
    const row = await queryOne<Record<string, unknown>>(
      `SELECT 1::int AS i, 9007199254740::bigint AS b, 1.5::float8 AS f, 12.30::numeric AS n, true AS t,
              '2024-01-05 10:00:00+00'::timestamptz AS ts, '{"a":1}'::jsonb AS j, 'x' AS s, NULL AS z`);
    expect(row).toEqual({ i: 1, b: 9007199254740, f: 1.5, n: "12.30", t: true, ts: "2024-01-05 10:00:00", j: { a: 1 }, s: "x", z: null });
  });

  it("expands array parameters like convertQuery", async () => {
    const rows = await query<{ v: number }>("SELECT v FROM (VALUES (1),(2),(3)) AS t(v) WHERE v IN $1 ORDER BY v", [[1, 3]]);
    expect(rows.map((r) => r.v)).toEqual([1, 3]);
  });

  it("rolls back on error and commits on success", async () => {
    await query("CREATE TABLE IF NOT EXISTS it_tx_probe (v int)");
    await query("DELETE FROM it_tx_probe");
    await expect(withTransaction(async (tx) => {
      await query("INSERT INTO it_tx_probe VALUES (1)", [], tx);
      throw new Error("boom");
    })).rejects.toThrow("boom");
    await withTransaction(async (tx) => { await query("INSERT INTO it_tx_probe VALUES (2)", [], tx); });
    expect((await query<{ v: number }>("SELECT v FROM it_tx_probe")).map((r) => r.v)).toEqual([2]);
    await query("DROP TABLE it_tx_probe");
  });
});
