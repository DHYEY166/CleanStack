/**
 * Route-level guest guards (defense in depth behind the middleware): every
 * blocked route answers 403 for a guest id before touching the database, S3 or Bedrock.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ userId: "guest_AAAAAAAAAAAAAAAAAAAAAA" as string | null, db: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ userId: h.userId }), currentUserEmail: async () => null, userEmailById: async () => null }));
vi.mock("@/lib/db", () => {
  const fail = (...a: unknown[]) => { h.db(...a); throw new Error("db must not be reached"); };
  return { query: fail, queryOne: fail, queryWithTeam: fail, queryOneWithTeam: fail, withTransaction: fail };
});
vi.mock("@/lib/ai-model", () => ({ languageModel: () => { throw new Error("model must not be reached"); } }));

const ID = "11111111-2222-3333-4444-555555555555";
const runCtx = { params: Promise.resolve({ runId: ID }) };
const idCtx = { params: Promise.resolve({ id: ID }) };
const req = (method = "POST", body: unknown = {}) =>
  new NextRequest("http://localhost/x", { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : JSON.stringify(body) });

const cases: Array<[string, () => Promise<Response>]> = [
  ["POST /api/chat-builder", async () => (await import("./chat-builder/route")).POST(req("POST", { messages: [] }))],
  ["POST /api/chat-builder/generate-data", async () => (await import("./chat-builder/generate-data/route")).POST(req())],
  ["POST /api/runs/:id/auto-clean", async () => (await import("./runs/[runId]/auto-clean/route")).POST(req(), runCtx)],
  ["GET /api/export-training/:id", async () => (await import("./export-training/[runId]/route")).GET(req("GET"), runCtx)],
  ["POST /api/alerts/configure", async () => (await import("./alerts/configure/route")).POST(req())],
  ["GET /api/alerts/configure", async () => (await import("./alerts/configure/route")).GET(req("GET"))],
  ["DELETE /api/account", async () => (await import("./account/route")).DELETE(req("DELETE"))],
  ["GET /api/templates", async () => (await import("./templates/route")).GET(req("GET"))],
  ["POST /api/templates", async () => (await import("./templates/route")).POST(req())],
  ["POST /api/templates/:id/use", async () => (await import("./templates/[id]/use/route")).POST(req(), idCtx)],
];

beforeEach(() => { h.db.mockClear(); });

describe("guest-blocked routes", () => {
  it.each(cases)("%s answers 403 for a guest", async (_name, call) => {
    const res = await call();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ guest: true });
    expect(h.db).not.toHaveBeenCalled();
  });
});
