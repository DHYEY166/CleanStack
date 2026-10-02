/**
 * The main pipeline end to end, server side, against real Postgres + LocalStack:
 * create pipeline -> /api/upload presigned POST (real S3) -> S3 ObjectCreated
 * notification (real SQS) -> profiler handler -> profile-complete ->
 * suggest-transforms (fake model) -> /api/approve-rules -> executor SQS message
 * -> executor handler -> /api/run-status -> /api/download presigned GET fetch.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";

vi.mock("@/lib/auth", async () => (await import("./helpers")).authMock);

import {
  allVersions, authState, db, env, invokeLambda, newUser, postUpload, purgeQueue, receive, request, sqsRecord, startAppServer,
} from "./helpers";
import { POST as createPipeline } from "@/app/api/pipelines/route";
import { POST as upload } from "@/app/api/upload/route";
import { POST as profileComplete } from "@/app/api/webhooks/profile-complete/route";
import { POST as suggestTransforms } from "@/app/api/suggest-transforms/route";
import { POST as approveRules } from "@/app/api/approve-rules/route";
import { GET as runStatus } from "@/app/api/run-status/[runId]/route";
import { GET as download } from "@/app/api/download/[runId]/route";
import { closePgPool } from "@/lib/db-pg";

const CSV = "name,amount,order_date\n  Alice ,$10.50,2024-01-05\nBob,20,01/06/2024\n Carol,30.25 ,2024-01-07\n";

let app: { url: string; server: Server };

beforeAll(async () => {
  app = await startAppServer({
    "POST /api/webhooks/profile-complete": profileComplete,
    "POST /api/suggest-transforms": suggestTransforms,
  });
  // Server-to-server calls (profile-complete -> suggest-transforms) go to the in-process app.
  process.env.NEXT_PUBLIC_APP_URL = app.url;
  await purgeQueue(env("RAW_EVENTS_QUEUE_URL"));
  await purgeQueue(env("SQS_QUEUE_URL"));
});

afterAll(async () => {
  await new Promise((r) => app.server.close(r));
  await closePgPool();
  await db.end();
});

describe("upload -> profile -> suggest -> approve -> execute -> download", () => {
  it("delivers a cleaned file without __orig_* columns through presigned POST/GET", async () => {
    const user = newUser();
    authState.userId = user;

    // 1. Pipeline + presigned upload
    const pRes = await createPipeline(request("/api/pipelines", { method: "POST", body: { name: "integration" } }));
    expect(pRes.status).toBe(201);
    const { pipeline } = await pRes.json();

    const uRes = await upload(request("/api/upload", { method: "POST", body: { pipeline_id: pipeline.id, filename: "orders.csv", size: CSV.length } }));
    expect(uRes.status).toBe(200);
    const { upload: post, run_id, s3_key, max_bytes } = await uRes.json();
    expect(new URL(post.url).hostname).toBe(`${env("S3_RAW_BUCKET")}.s3.localhost.localstack.cloud`);
    expect(post.fields.key).toBe(s3_key);
    expect(s3_key).toBe(`${user}/${pipeline.id}/${run_id}/raw.csv`);
    expect(max_bytes).toBe(100 * 1024 * 1024);

    const put = await postUpload(post, CSV, "orders.csv");
    expect(put.status).toBe(204);

    // 2. S3 -> SQS notification drives the profiler, exactly like the Lambda trigger
    const [notification] = await receive(env("RAW_EVENTS_QUEUE_URL"), (m) => (m.Body ?? "").includes(run_id), 1, 0);
    expect(notification, "no S3 ObjectCreated notification for the upload").toBeDefined();
    const profiled = await invokeLambda("profiler", JSON.parse(notification.Body!), { APP_URL: app.url });
    expect(profiled.result).toEqual({ statusCode: 200, run_id });

    // profiler -> profile-complete -> suggest-transforms (fake model) ran synchronously
    const s1 = await (await runStatus(request(`/api/run-status/${run_id}`), { params: Promise.resolve({ runId: run_id }) })).json();
    expect(s1.run.status).toBe("awaiting_approval");
    const { rows: rules } = await db.query(
      "SELECT id, rule_type, column_name FROM transform_rules WHERE run_id = $1 AND status = 'pending' ORDER BY order_index", [run_id]);
    expect(rules.map((r) => [r.rule_type, r.column_name])).toEqual([
      ["trim_whitespace", null], ["type_cast", "amount"], ["normalize", "order_date"],
    ]);

    // 3. Approve -> exactly one executor message
    const aRes = await approveRules(request("/api/approve-rules", {
      method: "POST",
      body: { run_id, rule_decisions: rules.map((r) => ({ rule_id: r.id, action: "approved", modifications: null })) },
    }));
    expect(aRes.status).toBe(200);
    const messages = await receive(env("SQS_QUEUE_URL"), (m) => JSON.parse(m.Body!).run_id === run_id, 1);
    expect(messages).toHaveLength(1);

    // 4. Executor (in-process Python, real S3 + Postgres)
    const executed = await invokeLambda("executor", { Records: messages.map(sqsRecord) });
    expect(executed.result).toEqual({ statusCode: 200, run_id });

    const s2 = await (await runStatus(request(`/api/run-status/${run_id}`), { params: Promise.resolve({ runId: run_id }) })).json();
    expect(s2.run.status).toBe("completed");
    expect(s2.run.row_count_processed).toBe(3);

    // 5. Download: presigned GET straight from S3
    const dRes = await download(request(`/api/download/${run_id}`), { params: Promise.resolve({ runId: run_id }) });
    expect(dRes.status).toBe(200);
    const { url, filename } = await dRes.json();
    const file = await fetch(url);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toContain("attachment");
    expect(file.headers.get("content-disposition")).toContain(filename);
    const lines = (await file.text()).trim().split("\n");
    expect(lines[0]).toBe("name,amount,order_date");
    expect(lines[0]).not.toContain("__orig_");
    expect(lines.slice(1)).toEqual(["Alice,10.5,2024-01-05", "Bob,20.0,2024-01-06", "Carol,30.25,2024-01-07"]);

    // Privacy: the raw upload is gone in every version (auto_delete_raw default)
    expect(await allVersions(env("S3_RAW_BUCKET"), `${user}/${pipeline.id}/${run_id}/`)).toEqual([]);

    // Another user cannot fetch the link
    authState.userId = newUser();
    const other = await download(request(`/api/download/${run_id}`), { params: Promise.resolve({ runId: run_id }) });
    expect(other.status).toBe(404);
  });
});
