import { describe, expect, it } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" };

describe("upload presigned POST", () => {
  it("signs a policy that S3 enforces: exact key, size range and content type", async () => {
    // Real AWS endpoint even when the shell points the SDK at LocalStack.
    const client = new S3Client({ region: "us-east-1", credentials, requestChecksumCalculation: "WHEN_REQUIRED", endpoint: "https://s3.us-east-1.amazonaws.com" });
    const { url, fields } = await createPresignedPost(client, {
      Bucket: "cleanstack-raw-test", Key: "u/p/r/raw.csv", Expires: 300,
      Conditions: [["content-length-range", 1, 2 * 1024 * 1024], ["eq", "$Content-Type", "text/csv"]],
      Fields: { "Content-Type": "text/csv" },
    });
    expect(url).toMatch(/^https:\/\/cleanstack-raw-test\.s3\.(us-east-1\.)?amazonaws\.com\/$/);
    expect(fields.key).toBe("u/p/r/raw.csv");
    const policy = JSON.parse(Buffer.from(fields.Policy, "base64").toString("utf8"));
    expect(policy.conditions).toEqual(expect.arrayContaining([
      ["content-length-range", 1, 2 * 1024 * 1024],
      ["eq", "$Content-Type", "text/csv"],
      { key: "u/p/r/raw.csv" },
      { bucket: "cleanstack-raw-test" },
    ]));
    expect(Object.keys(fields).join(",")).not.toMatch(/checksum/i);
  });

  it("the upload route presigns a POST (not a PUT) with a WHEN_REQUIRED client", () => {
    const src = readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");
    expect(src).toMatch(/new S3Client\(\{[^}]*requestChecksumCalculation: "WHEN_REQUIRED"/);
    expect(src).toContain("createPresignedPost(");
    expect(src).toContain('["content-length-range", 1, maxBytes]');
    expect(src).not.toContain("PutObjectCommand");
  });
});
