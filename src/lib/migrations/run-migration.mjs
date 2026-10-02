// Apply src/lib/schema.sql and then every NNN_*.sql migration in this folder,
// in filename order. Every statement is idempotent (IF NOT EXISTS), so the
// script is safe to re-run. Statements run one at a time and outside a
// transaction because CREATE INDEX CONCURRENTLY cannot run inside one.
//
// Connection (no defaults are hardcoded — nothing is committed for prod):
//   AURORA_HOST        required  cluster endpoint
//   AURORA_PORT        optional  default 5432
//   AURORA_USER        optional  default postgres (IAM auth must be enabled for it)
//   AURORA_DB          optional  default cleanstack
//   AWS_REGION         optional  default us-east-1
//   RDS_CA_BUNDLE      optional  path to the RDS CA bundle; enables TLS certificate
//                                verification (recommended). Without it TLS is still
//                                used but the server certificate is not verified.
//   MIGRATIONS_ONLY=1  optional  skip schema.sql
//
// Usage: AURORA_HOST=... node src/lib/migrations/run-migration.mjs
import pg from "pg";
import { Signer } from "@aws-sdk/rds-signer";
import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const { Client } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

const hostname = process.env.AURORA_HOST;
if (!hostname) {
  console.error("AURORA_HOST is required (the Aurora cluster endpoint).");
  process.exit(2);
}
const port = Number(process.env.AURORA_PORT ?? 5432);
const username = process.env.AURORA_USER ?? "postgres";
const database = process.env.AURORA_DB ?? "cleanstack";
const region = process.env.AWS_REGION ?? "us-east-1";

export function splitStatements(sql) {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const files = [
  ...(process.env.MIGRATIONS_ONLY === "1" ? [] : [join(__dirname, "..", "schema.sql")]),
  ...readdirSync(__dirname)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort()
    .map((f) => join(__dirname, f)),
];

const signer = new Signer({ hostname, port, username, region });
const token = await signer.getAuthToken();

const ssl = process.env.RDS_CA_BUNDLE
  ? { ca: readFileSync(process.env.RDS_CA_BUNDLE, "utf8"), rejectUnauthorized: true }
  : { rejectUnauthorized: false };

const client = new Client({ host: hostname, port, user: username, database, password: token, ssl });

await client.connect();
console.log(`Connected to ${hostname}/${database} (TLS verify: ${ssl.rejectUnauthorized})`);

try {
  for (const file of files) {
    console.log(`\n== ${file.split("/").slice(-2).join("/")}`);
    for (const stmt of splitStatements(readFileSync(file, "utf8"))) {
      console.log(`Running: ${stmt.replace(/\s+/g, " ").slice(0, 80)}...`);
      await client.query(stmt);
    }
  }
  console.log("\nAll migrations applied.");
} finally {
  await client.end();
}
