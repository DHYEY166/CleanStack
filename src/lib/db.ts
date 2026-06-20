import {
  RDSDataClient,
  ExecuteStatementCommand,
  BeginTransactionCommand,
  CommitTransactionCommand,
  RollbackTransactionCommand,
  type SqlParameter,
  type Field,
} from "@aws-sdk/client-rds-data";

const client = new RDSDataClient({
  region: process.env.AWS_REGION || "us-east-1",
});

const CLUSTER_ARN =
  process.env.AURORA_CLUSTER_ARN ||
  "arn:aws:rds:us-east-1:989088054490:cluster:database-1";

const SECRET_ARN =
  process.env.AURORA_SECRET_ARN ||
  "arn:aws:secretsmanager:us-east-1:989088054490:secret:cleanstack-db-master-VhiPpa";

const DATABASE = "cleanstack";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ISO 8601 date/datetime strings
const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;

type TypeHint = "UUID" | "TIMESTAMP" | "DATE" | "TIME" | "JSON";

function toParam(value: unknown): { field: Field; typeHint?: TypeHint } {
  if (value === null || value === undefined) return { field: { isNull: true } };
  if (typeof value === "boolean") return { field: { booleanValue: value } };
  if (typeof value === "number") {
    if (Number.isInteger(value)) return { field: { longValue: value } };
    return { field: { doubleValue: value } };
  }
  // Date instances → TIMESTAMP (must check before generic object)
  if (value instanceof Date) {
    return { field: { stringValue: value.toISOString() }, typeHint: "TIMESTAMP" };
  }
  if (typeof value === "object") {
    // Plain objects/arrays → JSONB
    return { field: { stringValue: JSON.stringify(value) }, typeHint: "JSON" };
  }
  const str = String(value);
  if (UUID_RE.test(str)) {
    return { field: { stringValue: str }, typeHint: "UUID" };
  }
  if (ISO_DATE_RE.test(str)) {
    return { field: { stringValue: str }, typeHint: "TIMESTAMP" };
  }
  return { field: { stringValue: str } };
}

/**
 * Converts $1,$2... positional params → :p1,:p2... named params.
 * Preserves SQL type casts (::uuid, ::jsonb, etc.) — PostgreSQL handles the cast.
 * Arrays passed as JS arrays are expanded: IN (:p1,:p2,...).
 * Only strips array-type suffixes (::text[], ::uuid[]) when expanding inline.
 */
function convertQuery(
  text: string,
  params: unknown[]
): { sql: string; parameters: SqlParameter[] } {
  const parameters: SqlParameter[] = [];
  let paramCount = 0;

  // Replace $N (without stripping type casts — keep ::uuid, ::jsonb etc. in SQL)
  const sql = text.replace(/\$(\d+)/g, (_match, n) => {
    const value = params[parseInt(n, 10) - 1];

    if (Array.isArray(value)) {
      const names = value.map((v) => {
        const name = `p${++paramCount}`;
        const { field, typeHint } = toParam(v);
        parameters.push({ name, value: field, ...(typeHint ? { typeHint } : {}) });
        return `:${name}`;
      });
      return `(${names.join(", ")})`;
    }

    const name = `p${++paramCount}`;
    const { field, typeHint } = toParam(value);
    parameters.push({ name, value: field, ...(typeHint ? { typeHint } : {}) });
    return `:${name}`;
  });

  // Strip orphaned array type casts left after inline expansion e.g. (:p1,:p2)::text[]
  const cleanSql = sql.replace(/\((:p\d+(?:,\s*:p\d+)*)\)::[a-z]+\[\]/gi, "($1)");

  return { sql: cleanSql, parameters };
}

function recordsToRows<T>(
  columnMetadata: Array<{ name?: string }>,
  records: Field[][]
): T[] {
  return records.map((record) => {
    const row: Record<string, unknown> = {};
    columnMetadata.forEach((col, i) => {
      const field = record[i];
      if (!col.name) return;
      if (field.isNull) {
        row[col.name] = null;
      } else if ("stringValue" in field) {
        const s = field.stringValue!;
        // Auto-parse JSONB columns returned as JSON strings
        if (s.length > 0 && (s[0] === "{" || s[0] === "[")) {
          try { row[col.name] = JSON.parse(s); } catch { row[col.name] = s; }
        } else {
          row[col.name] = s;
        }
      } else if ("longValue" in field) {
        row[col.name] = field.longValue;
      } else if ("doubleValue" in field) {
        row[col.name] = field.doubleValue;
      } else if ("booleanValue" in field) {
        row[col.name] = field.booleanValue;
      } else if ("arrayValue" in field) {
        row[col.name] = field.arrayValue;
      } else {
        row[col.name] = null;
      }
    });
    return row as T;
  });
}

export async function query<T = unknown>(
  text: string,
  params: unknown[] = [],
  transactionId?: string
): Promise<T[]> {
  const { sql, parameters } = convertQuery(text, params);

  const result = await client.send(
    new ExecuteStatementCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DATABASE,
      sql,
      parameters,
      transactionId,
      includeResultMetadata: true,
    })
  );

  if (!result.columnMetadata || !result.records) return [];
  return recordsToRows<T>(result.columnMetadata, result.records);
}

export async function queryOne<T = unknown>(
  text: string,
  params: unknown[] = [],
  transactionId?: string
): Promise<T | null> {
  const rows = await query<T>(text, params, transactionId);
  return rows[0] ?? null;
}

export async function withTransaction<T>(
  fn: (txId: string) => Promise<T>
): Promise<T> {
  const begin = await client.send(
    new BeginTransactionCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DATABASE,
    })
  );
  const txId = begin.transactionId!;
  try {
    const result = await fn(txId);
    await client.send(
      new CommitTransactionCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        transactionId: txId,
      })
    );
    return result;
  } catch (e) {
    await client.send(
      new RollbackTransactionCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        transactionId: txId,
      })
    );
    throw e;
  }
}

export default { query, queryOne, withTransaction };
