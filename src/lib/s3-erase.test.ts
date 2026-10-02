import { describe, expect, it, vi } from "vitest";
import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  type S3Client,
} from "@aws-sdk/client-s3";
import { keyDirectory, purgePrefix } from "./s3-erase";

function fakeS3(handler: (cmd: unknown) => unknown) {
  const send = vi.fn(async (cmd: unknown) => handler(cmd));
  return { client: { send } as unknown as S3Client, send };
}

describe("purgePrefix", () => {
  it("deletes every version and delete marker across pages", async () => {
    const pages = [
      { Versions: [{ Key: "u/p/r/raw.csv", VersionId: "v1" }], DeleteMarkers: [{ Key: "u/p/r/raw.csv", VersionId: "d1" }], IsTruncated: true, NextKeyMarker: "k", NextVersionIdMarker: "vm" },
      { Versions: [{ Key: "u/p/r/extracted_text.txt", VersionId: "v2" }], IsTruncated: false },
    ];
    const deletes: unknown[] = [];
    const { client, send } = fakeS3((cmd) => {
      if (cmd instanceof ListObjectVersionsCommand) return pages.shift();
      if (cmd instanceof DeleteObjectsCommand) { deletes.push(cmd.input.Delete?.Objects); return {}; }
      throw new Error("unexpected");
    });
    const res = await purgePrefix(client, "raw", "u/");
    expect(res).toEqual({ prefix: "u/", deleted: 3, versioned: true, errors: [] });
    expect(deletes).toEqual([
      [{ Key: "u/p/r/raw.csv", VersionId: "v1" }, { Key: "u/p/r/raw.csv", VersionId: "d1" }],
      [{ Key: "u/p/r/extracted_text.txt", VersionId: "v2" }],
    ]);
    const second = send.mock.calls[2][0] as ListObjectVersionsCommand;
    expect(second.input).toMatchObject({ KeyMarker: "k", VersionIdMarker: "vm", Prefix: "u/" });
  });

  it("falls back to current versions when ListBucketVersions is denied", async () => {
    const { client } = fakeS3((cmd) => {
      if (cmd instanceof ListObjectVersionsCommand) throw Object.assign(new Error("denied"), { name: "AccessDenied" });
      if (cmd instanceof ListObjectsV2Command) return { Contents: [{ Key: "u/a" }, { Key: "u/b" }], IsTruncated: false };
      if (cmd instanceof DeleteObjectsCommand) return {};
      throw new Error("unexpected");
    });
    const res = await purgePrefix(client, "raw", "u/");
    expect(res.versioned).toBe(false);
    expect(res.deleted).toBe(2);
  });

  it("reports per-object delete errors", async () => {
    const { client } = fakeS3((cmd) => {
      if (cmd instanceof ListObjectVersionsCommand) return { Versions: [{ Key: "u/a", VersionId: "1" }], IsTruncated: false };
      return { Errors: [{ Key: "u/a", VersionId: "1", Code: "AccessDenied" }] };
    });
    const res = await purgePrefix(client, "raw", "u/");
    expect(res.deleted).toBe(0);
    expect(res.errors).toEqual(["u/a@1: AccessDenied"]);
  });

  it("propagates non-permission errors so callers can abort", async () => {
    const { client } = fakeS3(() => { throw Object.assign(new Error("boom"), { name: "InternalError" }); });
    await expect(purgePrefix(client, "raw", "u/")).rejects.toThrow("boom");
  });

  it.each(["", "/", "noslash", "/abs/", "a/../b/"])("refuses unsafe prefix %j", async (prefix) => {
    const { client, send } = fakeS3(() => ({}));
    await expect(purgePrefix(client, "raw", prefix)).rejects.toThrow(/unsafe/);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("keyDirectory", () => {
  it("returns the parent prefix", () => {
    expect(keyDirectory("u/p/r/raw.csv")).toBe("u/p/r/");
    expect(keyDirectory("raw.csv")).toBeNull();
  });
});
