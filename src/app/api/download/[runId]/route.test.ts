import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const queryOneWithTeam = vi.fn();
const getSignedUrl = vi.fn();
const send = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({ auth: () => auth() }));
vi.mock("@/lib/db", () => ({ queryOneWithTeam: (...a: unknown[]) => queryOneWithTeam(...a) }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: (...a: unknown[]) => getSignedUrl(...a),
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { send = send; },
  GetObjectCommand: class { constructor(public input: Record<string, unknown>) {} },
}));

const { GET } = await import("./route");
const call = (runId = "11111111-2222-3333-4444-555555555555") =>
  GET(new Request("http://x/api/download/" + runId) as never, { params: Promise.resolve({ runId }) });

describe("GET /api/download/[runId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.S3_PROCESSED_BUCKET = "processed-bucket";
    auth.mockResolvedValue({ userId: "user_1" });
    getSignedUrl.mockResolvedValue("https://processed-bucket.s3.amazonaws.com/signed");
  });

  it("returns 401 without a session", async () => {
    auth.mockResolvedValue({ userId: null });
    expect((await call()).status).toBe(401);
  });

  it("returns 404 when the run is not a completed run of this team", async () => {
    queryOneWithTeam.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    expect(queryOneWithTeam.mock.calls[0][2]).toEqual(["11111111-2222-3333-4444-555555555555", "user_1"]);
  });

  it("presigns the stored object instead of proxying or rewriting it", async () => {
    queryOneWithTeam.mockResolvedValue({ processed_s3_key: "processed/p/r/output.xlsx", file_format: "xls" });
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({
      url: "https://processed-bucket.s3.amazonaws.com/signed",
      filename: "cleanstack_11111111.xlsx",
      format: "xlsx",
    });
    const [, cmd, opts] = getSignedUrl.mock.calls[0];
    expect(cmd.input).toMatchObject({
      Bucket: "processed-bucket",
      Key: "processed/p/r/output.xlsx",
      ResponseContentDisposition: 'attachment; filename="cleanstack_11111111.xlsx"',
      ResponseContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    expect(opts.expiresIn).toBeLessThanOrEqual(300);
    expect(send).not.toHaveBeenCalled();
  });

  it("fails closed when the bucket is not configured", async () => {
    delete process.env.S3_PROCESSED_BUCKET;
    queryOneWithTeam.mockResolvedValue({ processed_s3_key: "processed/p/r/output.csv", file_format: "csv" });
    const res = await call();
    expect(res.status).toBe(500);
    expect(getSignedUrl).not.toHaveBeenCalled();
  });
});
