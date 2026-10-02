/**
 * Result shaping shared by the Data API path and the test-only pg adapter:
 * the Data API returns JSON/JSONB (and any text) as strings, and db.ts
 * auto-parses strings that look like JSON objects/arrays.
 */
export function parseDataApiString(s: string): unknown {
  if (s.length > 0 && (s[0] === "{" || s[0] === "[")) {
    try { return JSON.parse(s); } catch { return s; }
  }
  return s;
}
