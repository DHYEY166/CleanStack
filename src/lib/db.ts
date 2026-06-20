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

function toField(value: unknown): Field {
  if (value === null || value === undefined) return { isNull: true };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    if (Number.isInteger(value)) return { longValue: value };
    return { doubleValue: value };
  }
  return { stringValue: String(value) };
}

/**
 * Converts $1,$2,... positional params to :p1,:p2,... named params.
 * Arrays are expanded inline: WHERE x = ANY($1::text[]) → WHERE x IN (:p1_0,:p1_1,...)
 */
function convertQuery(
  text: string,
  params: unknown[]
): { sql: string; parameters: SqlParameter[] } {
  const parameters: SqlParameter[] = [];
  let paramCount = 0;

  const sql = text.replace(/\$(\d+)(?:::[a-z\[\]]+)?/gi, (_match, n) => {
    const value = params[parseInt(n, 10) - 1];

    if (Array.isArray(value)) {
      // Expand array into individual named params
      const names = value.map((v) => {
        const name = `p${++paramCount}`;
        parameters.push({ name, value: toField(v) });
        return `:${name}`;
      });
      // Check if this was an ANY($n) pattern — replace with IN (...)
      const anyPattern = new RegExp(
        `=\\s*ANY\\s*\\(\\s*\\$${n}(?:::[a-z\\[\\]]+)?\\s*\\)`,
        "i"
      );
      if (anyPattern.test(text)) {
        return `IN (${names.join(", ")})`;
      }
      return `(${names.join(", ")})`;
    }

    const name = `p${++paramCount}`;
    parameters.push({ name, value: toField(value) });
    return `:${name}`;
  });

  // Clean up "= ANY(...)" that was already rewritten above
  const cleanSql = sql.replace(
    /IN\s*\(IN\s*\(([^)]+)\)\)/gi,
    "IN ($1)"
  );

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
        row[col.name] = field.stringValue;
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

// Keep default export for any legacy imports
export default { query, queryOne, withTransaction };
