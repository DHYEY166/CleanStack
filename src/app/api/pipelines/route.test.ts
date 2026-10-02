import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ userId: "user_1" as string | null, queryOne: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ userId: h.userId }) }));
vi.mock("@/lib/db", () => ({ query: vi.fn(), queryWithTeam: vi.fn(), queryOne: (...a: unknown[]) => h.queryOne(...a) }));

import { POST } from "./route";

const GUEST = "guest_AAAAAAAAAAAAAAAAAAAAAA";
const create = () => POST(new NextRequest("http://x/api/pipelines", { method: "POST", body: JSON.stringify({ name: " p " }) }));
beforeEach(() => { vi.clearAllMocks(); h.userId = "user_1"; });

describe("POST /api/pipelines", () => {
  it("users: plain insert", async () => {
    h.queryOne.mockResolvedValue({ id: "p1" });
    expect((await create()).status).toBe(201);
    expect(h.queryOne.mock.calls[0][0]).not.toContain("count(*)");
  });

  it("guests: insert capped at 5 pipelines, 429 past it", async () => {
    h.userId = GUEST;
    h.queryOne.mockResolvedValue({ id: "p1" });
    expect((await create()).status).toBe(201);
    const [sql, params] = h.queryOne.mock.calls[0];
    expect(sql).toContain("(SELECT count(*) FROM pipelines WHERE team_id = $3) < $4");
    expect(params).toEqual(["p", null, GUEST, 5, null]);
    h.queryOne.mockResolvedValue(null);
    const res = await create();
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("Guests can create 5 pipelines. Sign up to keep going.");
  });
});
