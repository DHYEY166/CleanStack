import pg from "pg";
import { Signer } from "@aws-sdk/rds-signer";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const { Client } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

const sql = readFileSync(join(__dirname, "001_indexes.sql"), "utf8");

const hostname = "database-1.cluster-cu5yscqo4b5k.us-east-1.rds.amazonaws.com";
const port = 5432;
const username = "postgres";
const region = "us-east-1";

const signer = new Signer({ hostname, port, username, region });
const token = await signer.getAuthToken();

const client = new Client({
  host: hostname,
  port,
  user: username,
  database: "cleanstack",
  password: token,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
console.log("Connected to Aurora.");

// Run each statement individually (CONCURRENTLY can't run inside a transaction)
// Strip comment lines first, then split on semicolons
const stripped = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const statements = stripped
  .split(";")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

for (const stmt of statements) {
  console.log(`Running: ${stmt.slice(0, 80)}...`);
  await client.query(stmt);
  console.log("  ✓ done");
}

await client.end();
console.log("\nAll indexes created.");
