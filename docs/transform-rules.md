# Transform rules

The model can suggest only rules that the executor implements, and a contract test (`lambdas/tests/test_contracts.py`) keeps the two lists in sync. In auto-clean, each rule's risk tier sets the number of committee votes it needs: LOW 1/3, MEDIUM 2/3, HIGH 3/3. When a rule fails or is unsafe (an unknown type, a missing column, more than 20% row loss, a bad regex, or a cast that would lose data), the executor restores the frame and records the rule as *not applied*, with the reason.

**Rows are never removed silently.** Only the row-selecting rules (`drop_nulls`, `filter`, `filter_extended`, `deduplicate`, `semantic_deduplicate`) can remove rows. The Data PR marks them "removes rows". The executor records how many rows each rule removed (`transform_rules.parameters._execution.rows_removed`), and the run page shows the count under the rule and the total in the run summary. A value that can't be converted (a placeholder in a numeric column, for example) becomes null in that cell. It never removes the row.

**Bad-cell guard.** A row-removing rule is flagged when it would remove otherwise valid rows only because one cell holds a bad value: a common placeholder (`.`, `-`, `?`, `N/A`, `#VALUE!`, ...) or, in a mostly numeric column, a value that is not a number. The check is deterministic and runs twice:

- **Before review** (`src/lib/rule-guard.ts`): after the AI returns rules, `filter`/`filter_extended` rules that remove rows for such a value (`neq`, `not_in`, `not_contains`), and `drop_nulls` on a column an earlier rule casts to a number, get `parameters._guard`. The rule card shows a warning and the suggested alternative (`type_cast` with `null_values`, so the cell becomes blank and the row stays). "Approve all" skips flagged rules, so each one needs its own decision, and auto-validate never approves one.
- **During execution** (`bad_cell_rows()` in the executor): the executor counts the rows each rule removed for one bad cell, where the rest of the row is at least half filled in, and records `_execution.bad_cell_rows`. The run page shows the count under the rule and in the run summary. In auto mode, where nobody approved the rule, the executor skips such a rule and keeps the rows. A rule a person approved in the Data PR still runs.

Legitimate filters are not flagged: comparisons (`gt`, `lt`, ...), keep-only matches (`eq`, `in`, `regex`), numeric values (`neq 0`), real text values (`neq "deleted"`, `not_in ["test"]`), removing blank cells, and rows that are mostly empty. Numeric codes such as `99999` are not treated as bad cells, because they can be real values. The placeholder list is shared by both checks (`PLACEHOLDER_TOKENS`, kept in sync by `lambdas/tests/test_contracts.py`).

## Tabular

| Rule | What it does |
|---|---|
| `trim_whitespace` | Strips leading and trailing whitespace from text values. Numbers in a mixed column stay numbers |
| `deduplicate` | Drops exact duplicate rows |
| `semantic_deduplicate` | Drops near-duplicate rows, keeping the first. Uses a MinHash Jaccard estimate ≥ `threshold` (default 0.8) over lowercased word sets, with LSH banding |
| `fill_nulls` | Fills nulls with the mean, median, mode or a constant |
| `drop_nulls` | With a column, drops rows where that column is null. Without one, drops rows with at least `ceil(threshold × columns)` nulls |
| `type_cast` | Casts to float, int, datetime or str. Values that can't be parsed become null, and the row is kept. Optional `null_values` (for example `[99999, "N/A"]`) also turns those placeholder codes into null. Not applied if values would be lost (for example `2.5` → int) |
| `normalize` | Text and date columns only. Converts dates to `YYYY-MM-DD` and trims and lowercases other text, or maps it through `value_map` |
| `filter`, `filter_extended` | Removes rows that match a condition. Comparison operators (`gt`, `lt`, `gte`, `lte`) remove only rows that hold a number outside the range. Rows whose value is missing or not a number are kept |
| `rename`, `column_header_normalize` | Renames columns, or converts headers to snake_case. A column's `__orig_` sidecar is renamed with it |
| `ner_redact` | Regex-based redaction of names, organizations, addresses or ZIP codes, and dates. This is a heuristic, not a trained NER model |
| `ffill`, `bfill` | Fills nulls from the previous or next row |
| `bool_cast` | Normalizes yes/no, true/false and 1/0 variants |
| `outlier_cap` | Caps values at the IQR fences |
| `multi_currency_strip` | Strips currency symbols and converts the values to numbers |
| `split_column` | Splits a column on a delimiter into new columns |

Rules that rewrite values keep the original in an `__orig_<column>` sidecar, which is written only to `audit.csv` and never to the deliverable. A sidecar is kept only if at least one value in the column lost information: a value became null or appeared, the text changed, or text became a number it doesn't spell exactly (`"$1,200"` → 1200, `"007"` → 7). A cast of `"34"` to 34, or a fill or cap that changed nothing, adds no sidecar.

## Documents (PDF, DOCX, TXT)

`strip_pii`, `ner_redact`, `fix_encoding`, `remove_headers_footers`, `remove_blank_lines`, `normalize_whitespace`, `strip_html` and `redact_pattern`. Patterns for `redact_pattern` are capped at 200 characters, and there is no protection against catastrophic backtracking.
