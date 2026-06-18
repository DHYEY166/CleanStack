import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { bedrock } from "@ai-sdk/amazon-bedrock";

export const maxDuration = 60;

interface Rule {
  rule_type: string;
  column_name: string | null;
  parameters: Record<string, unknown>;
  ai_reasoning: string;
}

interface GenerateRequest {
  description: string;
  config: { name: string; description: string; rules: Rule[] };
  format: "csv" | "json" | "jsonl" | "xlsx" | "tsv";
  row_count?: number;
}

function jsonToCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(",")),
  ].join("\n");
}

function jsonToTsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  return [
    headers.join("\t"),
    ...rows.map((r) => headers.map((h) => (r[h] == null ? "" : String(r[h]))).join("\t")),
  ].join("\n");
}

function jsonToXlsx(rows: Record<string, unknown>[]): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const XLSX = require("xlsx");
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Data");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

export async function POST(req: NextRequest) {
  const body: GenerateRequest = await req.json();
  const { description, config, format = "csv", row_count = 20 } = body;

  const rulesSummary = config.rules
    .map((r) => `- ${r.rule_type}${r.column_name ? ` on "${r.column_name}"` : ""}: ${r.ai_reasoning}`)
    .join("\n");

  const hasDateRule = config.rules.some((r) =>
    ["normalize", "type_cast"].includes(r.rule_type) && r.ai_reasoning.toLowerCase().includes("date")
  );
  const hasCurrencyRule = config.rules.some((r) =>
    r.rule_type === "type_cast" && r.ai_reasoning.toLowerCase().match(/currency|price|amount|salary|\$/)
  );
  const hasCaseRule = config.rules.some((r) => r.rule_type === "normalize");
  const hasFilterRule = config.rules.some((r) => r.rule_type === "filter");
  const hasNullRule = config.rules.some((r) => ["fill_nulls", "drop_nulls"].includes(r.rule_type));
  const hasDedupRule = config.rules.some((r) => r.rule_type === "deduplicate");
  const hasTrimRule = config.rules.some((r) => r.rule_type === "trim_whitespace");

  const dirtyPatterns = [
    hasDedupRule && "Include exactly 2 duplicate rows (identical values in all columns).",
    hasNullRule && "Leave ~15% of cells empty/null in non-ID columns.",
    hasDateRule && 'Mix at least 3 date formats: ISO "2024-01-15", US "01/15/2024", natural "Jan 15 2024".',
    hasCurrencyRule && 'Format monetary values with $ and commas: "$1,234.00", "$89.50".',
    hasCaseRule && 'Mix casing in categorical columns: "ACTIVE", "active", "Active", "SHIPPED", "shipped".',
    hasFilterRule && "Include 1-2 rows with logically invalid values (negative price, rating of -1 or 99).",
    hasTrimRule && 'Add leading/trailing spaces to 2-3 string values: "  John Smith  ", " Engineering ".',
    "Include at least one column with mixed data quality issues.",
  ].filter(Boolean).join("\n");

  const prompt = `You are generating realistic sample dirty data for a data quality demo platform.

User's data description: "${description}"

Data quality issues to demonstrate (from cleaning rules):
${rulesSummary}

Generate exactly ${row_count} rows of realistic data matching this domain. Output ONLY a raw JSON array — no markdown fences, no explanation, nothing else.

Mandatory dirty patterns to embed:
${dirtyPatterns}

Requirements:
- Column names must match what the user described, or use realistic domain-appropriate names
- Values must look realistic (real-sounding names, plausible numbers, actual company names)
- The dirty patterns must be clearly visible and spread across the dataset
- Output must be valid JSON parseable by JSON.parse()`;

  let rows: Record<string, unknown>[];
  try {
    const { text } = await generateText({
      model: bedrock("us.anthropic.claude-sonnet-4-6"),
      prompt,
      maxOutputTokens: 4000,
    });

    // Strip any accidental markdown fences
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    rows = JSON.parse(cleaned);
    if (!Array.isArray(rows)) throw new Error("Not an array");
  } catch (err) {
    console.error("[generate-data] AI/parse error:", err);
    return NextResponse.json({ error: "Failed to generate data" }, { status: 500 });
  }

  try {
    let responseBody: Uint8Array | string;
    let contentType: string;
    let ext: string;

    if (format === "json") {
      responseBody = JSON.stringify(rows, null, 2);
      contentType = "application/json";
      ext = "json";
    } else if (format === "jsonl") {
      responseBody = rows.map((r) => JSON.stringify(r)).join("\n");
      contentType = "application/x-ndjson";
      ext = "jsonl";
    } else if (format === "xlsx") {
      responseBody = new Uint8Array(jsonToXlsx(rows));
      contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      ext = "xlsx";
    } else if (format === "tsv") {
      responseBody = jsonToTsv(rows);
      contentType = "text/tab-separated-values";
      ext = "tsv";
    } else {
      responseBody = jsonToCsv(rows);
      contentType = "text/csv";
      ext = "csv";
    }

    const slug = config.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 30);
    const filename = `sample_${slug}.${ext}`;

    return new Response(responseBody as BodyInit, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[generate-data] format error:", err);
    return NextResponse.json({ error: "Format conversion failed" }, { status: 500 });
  }
}
