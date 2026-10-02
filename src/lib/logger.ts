/**
 * Minimal structured logger for server code (route handlers, lib).
 *
 * Emits one JSON object per line: {"ts","level","msg",...context,...fields}.
 * Vercel and CloudWatch index JSON lines, so fields such as run_id or route
 * become searchable instead of being buried in free text.
 *
 * - Error values are serialised as {name, message, stack} (plain
 *   console.error(err) prints them, JSON.stringify drops them as {}).
 * - Keys that look like credentials are redacted at any depth.
 * - LOG_LEVEL (debug|info|warn|error, default info) sets the threshold.
 * - warn/error go to stderr and info/debug to stdout, so log levels in the
 *   hosting platform still work.
 *
 * Browser components keep using console; this module is for the server.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(context: LogFields): Logger;
}

export type LogSink = (level: LogLevel, line: string) => void;

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACT_KEY = /(secret|token|password|passwd|authorization|cookie|api[-_]?key|credential|signature)/i;
const MAX_DEPTH = 6;

export function serializeError(err: unknown): LogFields {
  if (err instanceof Error) {
    const out: LogFields = { name: err.name, message: err.message };
    if (err.stack) out.stack = err.stack.split("\n").slice(0, 10).join("\n");
    const code = (err as { code?: unknown }).code;
    if (code !== undefined) out.code = code;
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status !== undefined) out.httpStatusCode = status;
    if (err.cause !== undefined) out.cause = sanitize(err.cause, 1, new WeakSet());
    return out;
  }
  return { message: String(err) };
}

function sanitize(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value instanceof Error) return serializeError(value);
  if (value === null || typeof value !== "object") {
    return typeof value === "bigint" ? value.toString() : value;
  }
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[Truncated]";
  seen.add(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1, seen));
  const out: LogFields = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT_KEY.test(k) ? "[REDACTED]" : sanitize(v, depth + 1, seen);
  }
  return out;
}

function threshold(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
  return ORDER[raw] ?? ORDER.info;
}

const defaultSink: LogSink = (level, line) => {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

export function createLogger(context: LogFields = {}, sink: LogSink = defaultSink): Logger {
  const emit = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (ORDER[level] < threshold()) return;
    const record = sanitize({ ...context, ...(fields ?? {}) }, 0, new WeakSet()) as LogFields;
    let line: string;
    try {
      line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...record });
    } catch {
      line = JSON.stringify({ ts: new Date().toISOString(), level, msg, logError: "unserializable fields" });
    }
    sink(level, line);
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (more) => createLogger({ ...context, ...more }, sink),
  };
}

export const logger = createLogger({ service: "cleanstack-web" });
