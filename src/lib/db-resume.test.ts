import { describe, expect, it, vi } from "vitest";
import { isDatabaseResuming, withResumeRetry, RESUME_RETRY_BUDGET_MS } from "@/lib/db-resume";

const resuming = () => Object.assign(new Error("The database is resuming"), { name: "DatabaseResumingException" });
const named = (name: string, message = "x") => Object.assign(new Error(message), { name });

/** Fake clock: sleep advances time instead of waiting. */
function clock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
  };
}

describe("isDatabaseResuming", () => {
  it("matches only the Data API resuming error", () => {
    expect(isDatabaseResuming(resuming())).toBe(true);
    expect(isDatabaseResuming(named("BadRequestException", "Communications link failure"))).toBe(false);
    expect(isDatabaseResuming(named("StatementTimeoutException"))).toBe(false);
    expect(isDatabaseResuming(named("DatabaseUnavailableException"))).toBe(false);
    expect(isDatabaseResuming(null)).toBe(false);
    expect(isDatabaseResuming("DatabaseResumingException")).toBe(false);
  });
});

describe("withResumeRetry", () => {
  it("waits with backoff while the database resumes, then returns the result", async () => {
    const c = clock();
    const send = vi.fn()
      .mockRejectedValueOnce(resuming())
      .mockRejectedValueOnce(resuming())
      .mockRejectedValueOnce(resuming())
      .mockResolvedValueOnce({ records: [] });
    await expect(withResumeRetry("ExecuteStatement", send, c)).resolves.toEqual({ records: [] });
    expect(send).toHaveBeenCalledTimes(4);
    expect(c.sleeps).toEqual([1000, 2000, 4000]);
  });

  it("does not retry other errors", async () => {
    for (const err of [named("StatementTimeoutException"), named("BadRequestException", "Communications link failure"),
      named("DatabaseErrorException", "duplicate key")]) {
      const c = clock();
      const send = vi.fn().mockRejectedValue(err);
      await expect(withResumeRetry("ExecuteStatement", send, c)).rejects.toBe(err);
      expect(send).toHaveBeenCalledTimes(1);
      expect(c.sleeps).toEqual([]);
    }
  });

  it("gives up after the budget and rethrows the resuming error", async () => {
    const c = clock();
    const err = resuming();
    const send = vi.fn().mockRejectedValue(err);
    await expect(withResumeRetry("BeginTransaction", send, c)).rejects.toBe(err);
    const waited = c.sleeps.reduce((a, b) => a + b, 0);
    expect(c.sleeps).toEqual([1000, 2000, 4000, 8000, 8000, 8000]); // capped at 8s
    expect(waited).toBeLessThanOrEqual(RESUME_RETRY_BUDGET_MS);
    expect(send).toHaveBeenCalledTimes(c.sleeps.length + 1);
  });

  it("logs one warn line per call that had to wait", async () => {
    const c = clock();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = vi.fn().mockRejectedValueOnce(resuming()).mockRejectedValueOnce(resuming()).mockResolvedValueOnce(1);
    await withResumeRetry("ExecuteStatement", send, c);
    const lines = warn.mock.calls.map((a) => String(a[0])).filter((l) => l.includes("resuming from auto-pause"));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ level: "warn", op: "ExecuteStatement" });
    warn.mockRestore();
  });
});
