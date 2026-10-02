import { describe, expect, it } from "vitest";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" };
const presign = (client: S3Client) =>
  getSignedUrl(client, new PutObjectCommand({ Bucket: "b", Key: "u/p/r/raw.csv", ContentType: "text/csv" }), { expiresIn: 300 });

describe("upload presigned PUT URL", () => {
  it("the SDK default bakes an empty-body checksum into the URL (why the route opts out)", async () => {
    const url = await presign(new S3Client({ region: "us-east-1", credentials }));
    expect(url).toContain("x-amz-checksum-crc32=AAAAAA%3D%3D");
  });

  it("with WHEN_REQUIRED the URL carries no checksum, so any body can be uploaded", async () => {
    const url = await presign(new S3Client({ region: "us-east-1", credentials, requestChecksumCalculation: "WHEN_REQUIRED" }));
    expect(url).not.toMatch(/x-amz-checksum|x-amz-sdk-checksum-algorithm/);
  });

  it("the upload route's presigning client uses WHEN_REQUIRED", () => {
    const src = readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");
    expect(src).toMatch(/new S3Client\(\{[^}]*requestChecksumCalculation: "WHEN_REQUIRED"/);
  });
});
