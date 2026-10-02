# Transform rules

The model can suggest only rules that the executor implements, and a contract test (`lambdas/tests/test_contracts.py`) keeps the two lists in sync. In auto-clean, each rule's risk tier sets the number of committee votes it needs: LOW 1/3, MEDIUM 2/3, HIGH 3/3. When a rule fails or is unsafe (an unknown type, a missing column, more than 20% row loss, a bad regex, or a cast that would lose data), the executor restores the frame and records the rule as *not applied*, with the reason.

## Tabular

| Rule | What it does |
|---|---|
| `trim_whitespace` | Strips leading and trailing whitespace in text columns |
| `deduplicate` | Drops exact duplicate rows |
| `semantic_deduplicate` | Drops near-duplicate rows, keeping the first. Uses a MinHash Jaccard estimate ≥ `threshold` (default 0.8) over lowercased word sets, with LSH banding |
| `fill_nulls` | Fills nulls with the mean, median, mode or a constant |
| `drop_nulls` | With a column, drops rows where that column is null. Without one, drops rows with at least `ceil(threshold × columns)` nulls |
| `type_cast` | Casts to float, int, datetime or str. Not applied if values would be lost (for example `2.5` → int) |
| `normalize` | Text and date columns only. Converts dates to `YYYY-MM-DD` and trims and lowercases other text, or maps it through `value_map` |
| `filter`, `filter_extended` | Removes rows that match a condition |
| `rename`, `column_header_normalize` | Renames columns, or converts headers to snake_case |
| `ner_redact` | Regex-based redaction of names, organizations, addresses or ZIP codes, and dates. This is a heuristic, not a trained NER model |
| `ffill`, `bfill` | Fills nulls from the previous or next row |
| `bool_cast` | Normalizes yes/no, true/false and 1/0 variants |
| `outlier_cap` | Caps values at the IQR fences |
| `multi_currency_strip` | Strips currency symbols and converts the values to numbers |
| `split_column` | Splits a column on a delimiter into new columns |

Rules that rewrite values keep the original in an `__orig_<column>` sidecar, which is written only to `audit.csv`.

## Documents (PDF, DOCX, TXT)

`strip_pii`, `ner_redact`, `fix_encoding`, `remove_headers_footers`, `remove_blank_lines`, `normalize_whitespace`, `strip_html` and `redact_pattern`. Patterns for `redact_pattern` are capped at 200 characters, and there is no protection against catastrophic backtracking.
