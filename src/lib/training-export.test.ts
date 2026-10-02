import { describe, expect, it } from "vitest";
import * as XLSX from "@e965/xlsx";
import { parseDeliverableRows, toTrainingFormat } from "@/lib/training-export";

const b = (s: string) => Buffer.from(s, "utf-8");

describe("parseDeliverableRows", () => {
  it("keeps cleaned CSV values verbatim (no re-typing of zips or dates)", () => {
    const rows = parseDeliverableRows(b('id,zip,name,date\n1,00123,"Doe, J",2024-01-02\n'), "csv");
    expect(rows).toEqual([{ id: "1", zip: "00123", name: "Doe, J", date: "2024-01-02" }]);
  });

  it("parses TSV with quoted tabs", () => {
    const rows = parseDeliverableRows(b('id\tname\n1\t"a\tb"\n2\tc\n'), "tsv");
    expect(rows).toEqual([{ id: "1", name: "a\tb" }, { id: "2", name: "c" }]);
  });

  it("drops __orig_* audit keys from every format", () => {
    const csv = parseDeliverableRows(b("name,__orig_name\nalice,ALICE \n"), "csv");
    const json = parseDeliverableRows(b(JSON.stringify([{ name: "alice", __orig_name: "ALICE " }])), "json");
    const jsonl = parseDeliverableRows(b('{"name":"alice","__orig_name":"x"}\n\n{"name":"bob"}\n'), "jsonl");
    const ws = XLSX.utils.json_to_sheet([{ name: "alice", __orig_name: "ALICE " }]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "s");
    const xlsx = parseDeliverableRows(Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })), "xlsx");
    for (const rows of [csv, json, xlsx]) expect(rows).toEqual([{ name: "alice" }]);
    expect(jsonl).toEqual([{ name: "alice" }, { name: "bob" }]);
  });

  it("wraps a single JSON object", () => {
    expect(parseDeliverableRows(b('{"a":1}'), "json")).toEqual([{ a: 1 }]);
  });
});

describe("toTrainingFormat", () => {
  const rows = [{ a: 1 }];
  it("raw", () => expect(toTrainingFormat(rows, "raw_jsonl")).toBe('{"a":1}'));
  it("alpaca", () => expect(JSON.parse(toTrainingFormat(rows, "alpaca")).input).toBe('{"a":1}'));
  it("chat", () => expect(JSON.parse(toTrainingFormat(rows, "chat")).messages[0].content).toBe('{"a":1}'));
});
