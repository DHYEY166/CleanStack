import { beforeEach, describe, expect, it, vi } from "vitest";

// The Data API path of src/lib/db.ts: every client call goes through the resume retry.
const send = vi.fn();
vi.mock("@aws-sdk/client-rds-data", () => {
  const cmd = (type: string) => class { type = type; constructor(public input: unknown) {} };
  return {
    RDSDataClient: class { send = (...a: unknown[]) => send(...a); },
    ExecuteStatementCommand: cmd("ExecuteStatement"),
    BeginTransactionCommand: cmd("BeginTransaction"),
    CommitTransactionCommand: cmd("CommitTransaction"),
    RollbackTransactionCommand: cmd("RollbackTransaction"),
  };
});
vi.mock("@/lib/db-resume", async (orig) => {
  const real = await orig<typeof import("@/lib/db-resume")>();
  // Same retry logic, no real waiting.
  return { ...real, withResumeRetry: <T>(op: string, fn: () => Promise<T>) => real.withResumeRetry(op, fn, { sleep: async () => {} }) };
});

process.env.AURORA_CLUSTER_ARN = "arn:aws:rds:us-east-1:1:cluster:database-1";
process.env.AURORA_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:1:secret:x";
delete process.env.DB_DRIVER;
const { query, withTransaction } = await import("@/lib/db");

const resuming = () => Object.assign(new Error("resuming"), { name: "DatabaseResumingException" });

describe("db (Data API driver)", () => {
  beforeEach(() => {
    send.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("retries ExecuteStatement while the cluster resumes", async () => {
    send.mockRejectedValueOnce(resuming()).mockRejectedValueOnce(resuming()).mockResolvedValueOnce({
      columnMetadata: [{ name: "n", typeName: "int4" }], records: [[{ longValue: 1 }]],
    });
    await expect(query("SELECT 1 AS n")).resolves.toEqual([{ n: 1 }]);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("does not retry a failed statement", async () => {
    send.mockRejectedValueOnce(Object.assign(new Error("duplicate key"), { name: "DatabaseErrorException" }));
    await expect(query("INSERT INTO t VALUES (1)")).rejects.toThrow("duplicate key");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries BeginTransaction and Commit", async () => {
    send.mockImplementation(async (cmd: { type: string }) => {
      if (cmd.type === "BeginTransaction") {
        if (send.mock.calls.length === 1) throw resuming();
        return { transactionId: "tx1" };
      }
      if (cmd.type === "CommitTransaction" && send.mock.calls.filter((c) => c[0].type === "CommitTransaction").length === 1) {
        throw resuming();
      }
      return {};
    });
    await expect(withTransaction(async () => "ok")).resolves.toBe("ok");
    expect(send.mock.calls.map((c) => c[0].type)).toEqual(["BeginTransaction", "BeginTransaction", "CommitTransaction", "CommitTransaction"]);
  });
});
