import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  type ObjectIdentifier,
  type S3Client,
} from "@aws-sdk/client-s3";

export interface PurgeResult {
  prefix: string;
  deleted: number;
  /** false when ListBucketVersions was denied and only current versions were removed */
  versioned: boolean;
  errors: string[];
}

const BATCH = 1000;

function assertSafePrefix(prefix: string) {
  const p = prefix.trim();
  if (!p || p === "/" || !p.endsWith("/") || p.startsWith("/") || p.includes("..")) {
    throw new Error(`refusing to purge unsafe S3 prefix: ${JSON.stringify(prefix)}`);
  }
}

async function deleteBatch(s3: S3Client, bucket: string, objects: ObjectIdentifier[], result: PurgeResult) {
  for (let i = 0; i < objects.length; i += BATCH) {
    const chunk = objects.slice(i, i + BATCH);
    const res = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: chunk, Quiet: true } }));
    const errs = res.Errors ?? [];
    result.deleted += chunk.length - errs.length;
    for (const e of errs) result.errors.push(`${e.Key}${e.VersionId ? `@${e.VersionId}` : ""}: ${e.Code ?? e.Message}`);
  }
}

function isAccessDenied(err: unknown) {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "AccessDenied" || e?.Code === "AccessDenied" || e?.$metadata?.httpStatusCode === 403;
}

/**
 * Permanently delete everything under `prefix`: every object version and every
 * delete marker (so nothing is recoverable on a versioned bucket). If the
 * caller lacks s3:ListBucketVersions it falls back to deleting current
 * versions only and reports `versioned: false`.
 *
 * Throws if S3 rejects a request (other than the AccessDenied fallback) so the
 * caller can abort before deleting the database rows that index the data.
 */
export async function purgePrefix(s3: S3Client, bucket: string, prefix: string): Promise<PurgeResult> {
  assertSafePrefix(prefix);
  const result: PurgeResult = { prefix, deleted: 0, versioned: true, errors: [] };

  try {
    let KeyMarker: string | undefined;
    let VersionIdMarker: string | undefined;
    for (;;) {
      const page = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix, KeyMarker, VersionIdMarker }));
      const objects: ObjectIdentifier[] = [
        ...(page.Versions ?? []),
        ...(page.DeleteMarkers ?? []),
      ]
        .filter((v) => v.Key)
        .map((v) => ({ Key: v.Key!, VersionId: v.VersionId }));
      if (objects.length) await deleteBatch(s3, bucket, objects, result);
      if (!page.IsTruncated) break;
      KeyMarker = page.NextKeyMarker;
      VersionIdMarker = page.NextVersionIdMarker;
    }
    return result;
  } catch (err) {
    if (!isAccessDenied(err)) throw err;
  }

  // Fallback: no s3:ListBucketVersions permission — delete current versions only.
  result.versioned = false;
  let ContinuationToken: string | undefined;
  for (;;) {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken }));
    const objects = (page.Contents ?? []).filter((o) => o.Key).map((o) => ({ Key: o.Key! }));
    if (objects.length) await deleteBatch(s3, bucket, objects, result);
    if (!page.IsTruncated) break;
    ContinuationToken = page.NextContinuationToken;
  }
  return result;
}

/** Directory prefix ("a/b/c/") of an object key, or null for top-level keys. */
export function keyDirectory(key: string): string | null {
  const idx = key.lastIndexOf("/");
  return idx > 0 ? key.slice(0, idx + 1) : null;
}
