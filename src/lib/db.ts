import { Pool, type PoolConfig } from "pg";
import { Signer } from "@aws-sdk/rds-signer";

function buildPool(): Pool {
  const dbUrl = new URL(process.env.DATABASE_URL!);
  const hostname = dbUrl.hostname;
  const port = parseInt(dbUrl.port || "5432");
  const username = decodeURIComponent(dbUrl.username);
  const database = dbUrl.pathname.replace(/^\//, "");
  const region = process.env.AWS_REGION || "us-east-1";

  const isProduction = process.env.NODE_ENV === "production";

  const config: PoolConfig = {
    host: hostname,
    port,
    user: username,
    database,
    ssl: isProduction ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };

  if (isProduction) {
    const signer = new Signer({ hostname, port, username, region });
    config.password = () => signer.getAuthToken();
  } else {
    config.password = decodeURIComponent(dbUrl.password);
  }

  return new Pool(config);
}

const pool = buildPool();

export default pool;

export async function query<T = unknown>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

export async function queryOne<T = unknown>(
  text: string,
  params?: unknown[]
): Promise<T | null> {
  const result = await pool.query(text, params);
  return (result.rows[0] as T) ?? null;
}
