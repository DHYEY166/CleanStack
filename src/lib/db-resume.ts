/**
 * Wait-and-retry for RDS Data API calls while Aurora Serverless v2 resumes
 * from auto-pause (min 0 ACU). The first Data API request to a paused cluster
 * fails with DatabaseResumingException and starts the resume, which usually
 * takes about 15s (30s or more after a pause longer than 24h, per the Aurora
 * auto-pause docs).
 *
 * Only the resuming error is retried. AWS documents it as "the request was
 * cancelled because the DB instance was paused", so the statement never ran
 * and retrying a write (INSERT/UPDATE, BeginTransaction, Commit) is safe. Every
 * other error is rethrown at once, including StatementTimeoutException,
 * DatabaseUnavailableException and connection failures, which can happen after
 * a statement was sent, so a non-idempotent statement is never run twice.
 *
 * The wait is capped (RESUME_RETRY_BUDGET_MS) so a call still fits in short
 * routes: the cron routes have maxDuration 60.
 */
import { logger } from "@/lib/logger";

const log = logger.child({ module: "db" });

export const RESUME_RETRY_BUDGET_MS = 35_000;
const FIRST_DELAY_MS = 1_000;
const MAX_DELAY_MS = 8_000;

/**
 * The Data API's error for this case on Aurora Serverless v2 (HTTP 400, client
 * fault, so the SDK's own retry strategy does not retry it). The
 * BadRequestException "Communications link failure" seen during resumes is
 * documented for Serverless v1 only and is not treated as resuming.
 */
export function isDatabaseResuming(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { name?: unknown }).name === "DatabaseResumingException";
}

export interface ResumeRetryOptions {
  budgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `send`, retrying with backoff (1s, 2s, 4s, 8s, 8s, ...) only while the
 * database is resuming, until the budget would be exceeded; then the last
 * resuming error is rethrown. Logs one warn line per call that had to wait.
 */
export async function withResumeRetry<T>(
  op: string,
  send: () => Promise<T>,
  { budgetMs = RESUME_RETRY_BUDGET_MS, sleep = realSleep, now = Date.now }: ResumeRetryOptions = {}
): Promise<T> {
  const deadline = now() + budgetMs;
  let delay = FIRST_DELAY_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (err) {
      if (!isDatabaseResuming(err) || now() + delay > deadline) throw err;
      if (attempt === 1) {
        log.warn("database is resuming from auto-pause; retrying Data API call", { op, budget_ms: budgetMs });
      }
      await sleep(delay);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
  }
}
