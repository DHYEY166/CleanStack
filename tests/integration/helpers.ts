import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { NextRequest } from "next/server";
import {
  S3Client, ListObjectVersionsCommand, PutObjectCommand,
  type ObjectVersion, type DeleteMarkerEntry,
} from "@aws-sdk/client-s3";
import { SQSClient, PurgeQueueCommand, ReceiveMessageCommand, DeleteMessageCommand, type Message } from "@aws-sdk/client-sqs";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set (vitest.integration.config.mts sets it)`);
  return v;
};

// ---- auth: route handlers are called outside a Next request, so @/lib/auth is
// mocked (vi.mock in each file) to read this mutable signed-in user.
export const authState: { userId: string | null } = { userId: null };
export const authMock = {
  auth: async () => ({ userId: authState.userId }),
  currentUserEmail: async () => (authState.userId ? `${authState.userId}@e2e.cleanstack.test` : null),
  userEmailById: async (id: string) => `${id}@e2e.cleanstack.test`,
};
export const newUser = () => `user_test_it_${randomUUID().slice(0, 8)}`;

// ---- clients
export const s3 = new S3Client({ region: env("AWS_REGION") });
export const sqs = new SQSClient({ region: env("AWS_REGION") });
export const db = new pg.Pool({ connectionString: env("DATABASE_URL"), max: 4 });

export function request(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

export async function allVersions(bucket: string, prefix: string): Promise<Array<ObjectVersion | DeleteMarkerEntry>> {
  const out: Array<ObjectVersion | DeleteMarkerEntry> = [];
  let KeyMarker: string | undefined, VersionIdMarker: string | undefined;
  do {
    const page = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix, KeyMarker, VersionIdMarker }));
    out.push(...(page.Versions ?? []), ...(page.DeleteMarkers ?? []));
    KeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    VersionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (KeyMarker);
  return out;
}

export async function putObject(bucket: string, key: string, body: string) {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "text/csv" }));
}

/** Upload through a presigned POST from /api/upload, like the browser does. */
export async function postUpload(upload: { url: string; fields: Record<string, string> }, body: string, filename = "raw.csv") {
  const form = new FormData();
  for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
  form.append("file", new Blob([body], { type: upload.fields["Content-Type"] }), filename);
  return fetch(upload.url, { method: "POST", body: form });
}

export async function purgeQueue(url: string) {
  await sqs.send(new PurgeQueueCommand({ QueueUrl: url }));
}

/** Receive (and delete) messages until `predicate` has matched `count`, then wait `settleSeconds` for extras. */
export async function receive(url: string, predicate: (m: Message) => boolean, count: number, settleSeconds = 2): Promise<Message[]> {
  const matched: Message[] = [];
  const deadline = Date.now() + 30_000;
  let settle = false;
  while (Date.now() < deadline) {
    const res = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: settle ? settleSeconds : 1,
      MessageSystemAttributeNames: ["ApproximateReceiveCount"],
    }));
    for (const m of res.Messages ?? []) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle! }));
      if (predicate(m)) matched.push(m);
    }
    if (settle) break;
    if (matched.length >= count) settle = true;
  }
  return matched;
}

/** SQS Message -> the record shape a Lambda SQS event carries. */
export const sqsRecord = (m: Message) => ({
  messageId: m.MessageId, receiptHandle: m.ReceiptHandle, body: m.Body,
  attributes: { ApproximateReceiveCount: m.Attributes?.ApproximateReceiveCount ?? "1" },
  eventSource: "aws:sqs",
});

/**
 * Run lambdas/<name>/handler.py in-process in Python (tests/support/invoke_lambda.py).
 * Async on purpose: the handler may call back into startAppServer() in this process.
 */
export async function invokeLambda(name: "executor" | "profiler", event: unknown, extraEnv: Record<string, string> = {}) {
  const python = process.env.PYTHON ?? "python3";
  const child = spawn(python, [join(ROOT, "tests/support/invoke_lambda.py"), name], {
    env: { ...process.env, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.stdin.end(JSON.stringify(event));
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  const result = /^__RESULT__ (.*)$/m.exec(stdout);
  if (code !== 0 || !result) throw new Error(`${name} handler failed (exit ${code}):\n${stdout}${stderr}`);
  return { result: JSON.parse(result[1]), logs: stdout + stderr };
}

type Handler = (req: NextRequest) => Promise<Response>;

/**
 * A tiny HTTP server that dispatches to route handlers in-process, standing in
 * for the deployed app wherever code makes server-to-server calls
 * (profiler -> profile-complete -> suggest-transforms).
 */
export async function startAppServer(routes: Record<string, Handler>): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const path = (req.url ?? "/").split("?")[0];
      const handler = routes[`${req.method} ${path}`];
      if (!handler) { res.writeHead(404).end(`no test route for ${req.method} ${path}`); return; }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
      const nreq = new NextRequest(`http://${req.headers.host}${req.url}`, {
        method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
      });
      const out = await handler(nreq);
      res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
      res.end(Buffer.from(await out.arrayBuffer()));
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return { url: `http://127.0.0.1:${addr.port}`, server };
}
