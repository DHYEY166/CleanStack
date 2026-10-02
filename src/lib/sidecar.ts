/**
 * Executor audit ("sidecar") columns are named `__orig_<column>`.
 *
 * Since the review-fixes executor they never appear in a deliverable
 * (`output.<ext>`): they are written to a separate `audit.csv` next to it.
 * The only consumer that still needs this module is the training export,
 * which parses deliverables into records and must never emit pre-transform
 * values, even for files produced by an older executor.
 */
export const SIDECAR_PREFIX = "__orig_";

export function isSidecarKey(name: unknown): boolean {
  return typeof name === "string" && name.startsWith(SIDECAR_PREFIX);
}

/** Return a copy of `record` without any `__orig_*` keys. */
export function stripSidecarKeys<T extends Record<string, unknown>>(record: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (!isSidecarKey(k)) out[k] = v;
  }
  return out as T;
}
