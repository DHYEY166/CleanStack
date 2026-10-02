import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const LIB = join(process.cwd(), "src", "lib");
const MIGRATIONS = join(LIB, "migrations");

/** table name -> column names, from every CREATE TABLE in the given SQL. */
function tables(sql: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const re = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\);/g;
  for (const m of sql.matchAll(re)) {
    const cols = new Set(
      m[2]
        .split("\n")
        .map((l) => l.trim().split(/\s+/)[0])
        .filter((c) => c && /^[a-z_]+$/.test(c) && !["check", "unique", "primary", "foreign"].includes(c)),
    );
    out.set(m[1], cols);
  }
  return out;
}

const schema = tables(readFileSync(join(LIB, "schema.sql"), "utf8"));
const migrationFiles = readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
const migrated = tables(migrationFiles.map((f) => readFileSync(join(MIGRATIONS, f), "utf8")).join("\n"));

// Every table the app and Lambdas read or write.
const APP_TABLES = [
  "pipelines", "pipeline_runs", "data_profiles", "transform_rules", "approval_reviews",
  "schema_snapshots", "pipeline_templates", "pipeline_destinations", "subscriptions",
  "bedrock_usage", "ai_spend_limits", "guest_sessions",
];

describe("database schema", () => {
  it("schema.sql creates every table the code uses", () => {
    for (const t of APP_TABLES) expect(schema.has(t), t).toBe(true);
  });

  it("existing databases get the AI usage tables from a numbered migration", () => {
    expect(migrationFiles).toContain("002_ai_usage_tables.sql");
    for (const t of ["bedrock_usage", "ai_spend_limits"]) {
      expect(migrated.get(t), t).toEqual(schema.get(t));
    }
  });

  it("existing databases get guest_sessions from 003", () => {
    expect(migrationFiles).toContain("003_guest_sessions.sql");
    expect(migrated.get("guest_sessions")).toEqual(schema.get("guest_sessions"));
  });

  it("bedrock_usage has every column bedrock-meter inserts", () => {
    const src = readFileSync(join(LIB, "bedrock-meter.ts"), "utf8");
    const cols = /INSERT INTO bedrock_usage \(([^)]+)\)/.exec(src)![1].split(",").map((c) => c.trim());
    for (const c of cols) expect(schema.get("bedrock_usage")!.has(c), c).toBe(true);
    for (const c of ["soft_cap_usd", "hard_cap_usd", "team_id"]) {
      expect(schema.get("ai_spend_limits")!.has(c), c).toBe(true);
    }
  });

  it("migrations are idempotent", () => {
    for (const f of migrationFiles) {
      const sql = readFileSync(join(MIGRATIONS, f), "utf8");
      for (const stmt of sql.match(/CREATE (TABLE|INDEX)[^;]*/g) ?? []) {
        expect(stmt, `${f}: ${stmt.slice(0, 60)}`).toMatch(/IF NOT EXISTS/);
      }
    }
  });

  it("the migration runner hardcodes no database host", () => {
    const runner = readFileSync(join(MIGRATIONS, "run-migration.mjs"), "utf8");
    expect(runner).not.toMatch(/rds\.amazonaws\.com/);
    expect(runner).toMatch(/process\.env\.AURORA_HOST/);
  });
});
