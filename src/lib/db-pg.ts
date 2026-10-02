/**
 * TEST-ONLY database adapter: direct Postgres (node-postgres) instead of the
 * RDS Data API, so integration/e2e suites can run against a plain Postgres
 * container. Loaded by src/lib/db.ts only when DB_DRIVER=pg AND isTestMode();
 * production never imports this module.
 *
 * It mirrors the Data API behaviour that application code depends on:
 * - parameters: `$N` placeholders; JS arrays expand to `($a, $b, ...)` and an
 *   orphaned `::type[]` cast after the expansion is dropped (as in
 *   convertQuery); plain objects are sent as JSON text; Dates as ISO strings.
 * - results: booleans, integers (incl. bigint, as the Data API returns
 *   longValue) and floats are numbers; NUMERIC, text, uuid and json stay
 *   strings; timestamps are UTC strings without an offset
 *   ("YYYY-MM-DD HH:MM:SS[.fff]"); any string starting with "{" or "[" that is
 *   valid JSON is parsed, exactly like recordsToRows() does.
 * Known gap: Postgres arrays come back as their text form ("{a,b}"), not as
 * the Data API's arrayValue object. No application query reads array columns.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { parseDataApiString } from "@/lib/db-shape";

const OID = {
  bool: 16, int8: 20, int2: 21, int4: 23, float4: 700, float8: 701, timestamp: 1114, timestamptz: 1184,
} as const;

function parseValue(oid: number, raw: string): unknown {
  switch (oid) {
    case OID.bool: return raw === "t";
    case OID.int2: case OID.int4: case OID.int8: return Number(raw);
    case OID.float4: case OID.float8: return Number(raw);
    case OID.timestamptz: return raw.replace(/\+00(:00)?$/, "");
    default: return raw;
  }
}

/** Type parser config: every value arrives as text and is shaped like the Data API would. */
export const dataApiTypes = {
  getTypeParser: (oid: number) => (raw: string) => parseValue(oid, raw),
} as unknown as pg.CustomTypesConfig;

function toPgValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return value;
}

/** `$N` + params -> node-postgres text/values, expanding array params like the Data API path. */
export function toPgQuery(text: string, params: unknown[]): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const sql = text.replace(/\$(\d+)/g, (_m, n) => {
    const value = params[parseInt(n, 10) - 1];
    if (Array.isArray(value)) {
      const names = value.map((v) => {
        values.push(toPgValue(v));
        return `$${values.length}`;
      });
      return `(${names.join(", ")})`;
    }
    values.push(toPgValue(value));
    return `$${values.length}`;
  });
  const clean = sql.replace(/\((\$\d+(?:,\s*\$\d+)*)\)::[a-z]+\[\]/gi, "($1)");
  return { text: clean, values };
}

export function shapeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === "string" ? parseDataApiString(v) : v;
  return out;
}

let pool: pg.Pool | null = null;
function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Configuration error: DATABASE_URL is not set (DB_DRIVER=pg)");
    // Session TimeZone=UTC as a startup parameter (not a post-connect query, which
    // would race the first statement on the connection).
    pool = new pg.Pool({ connectionString, max: 10, types: dataApiTypes, options: "-c TimeZone=UTC" });
  }
  return pool;
}

const transactions = new Map<string, pg.PoolClient>();

export async function pgQuery<T>(text: string, params: unknown[], transactionId?: string): Promise<T[]> {
  const q = toPgQuery(text, params);
  const runner = transactionId ? transactions.get(transactionId) : getPool();
  if (!runner) throw new Error(`Unknown transaction ${transactionId}`);
  const res = await runner.query(q.text, q.values);
  return (res.rows ?? []).map(shapeRow) as T[];
}

export async function pgWithTransaction<T>(fn: (txId: string) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  const txId = randomUUID();
  transactions.set(txId, client);
  try {
    await client.query("BEGIN");
    const result = await fn(txId);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    transactions.delete(txId);
    client.release();
  }
}

/** For test teardown. */
export async function closePgPool(): Promise<void> {
  const p = pool;
  pool = null;
  if (p) await p.end();
}
