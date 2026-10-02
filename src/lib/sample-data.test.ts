import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEMO_TEMPLATE_ID, DEMO_TEMPLATE_RULES, SAMPLE_CSV } from "./sample-data";
import { GUEST_LIMITS } from "./guest-limits";

// Same splitting as src/lib/migrations/run-migration.mjs (which connects on import).
const splitStatements = (sql: string) =>
  sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((x) => x.trim()).filter(Boolean);

const MIGRATION = readFileSync(join(__dirname, "migrations", "003_guest_sessions.sql"), "utf8");

describe("sample data", () => {
  it("migration 003 seeds the demo template with the same id and rules", () => {
    const insert = splitStatements(MIGRATION).find((s) => s.startsWith("INSERT INTO pipeline_templates"))!;
    expect(insert).toContain(`'${DEMO_TEMPLATE_ID}'`);
    expect(insert).toMatch(/ON CONFLICT \(id\) DO NOTHING$/);
    const json = /'(\[[\s\S]*\])'::jsonb/.exec(insert)![1];
    expect(JSON.parse(json)).toEqual(DEMO_TEMPLATE_RULES);
  });

  it("every 003 statement is safe to send alone through the RDS Data API", () => {
    // One statement per execute-statement call (README checklist): no semicolons inside statements.
    const stmts = splitStatements(MIGRATION);
    expect(stmts.length).toBe(6);
    for (const s of stmts) expect(s).not.toContain(";");
  });

  it("the file fits the guest limits", () => {
    expect(Buffer.byteLength(SAMPLE_CSV)).toBeLessThan(GUEST_LIMITS.maxUploadBytes);
    expect(SAMPLE_CSV.trim().split("\n").length - 1).toBeLessThan(GUEST_LIMITS.rowsPerRun);
  });

  it("rule columns exist in the file", () => {
    const header = SAMPLE_CSV.split("\n")[0].split(",");
    for (const r of DEMO_TEMPLATE_RULES) if (r.column_name) expect(header).toContain(r.column_name);
  });
});
