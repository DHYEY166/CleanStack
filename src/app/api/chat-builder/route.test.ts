import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ budget: vi.fn(), meter: vi.fn(), streamText: vi.fn(), generateText: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ userId: "user_1" }) }));
vi.mock("@/lib/bedrock-meter", () => ({ checkAiBudget: (...a: unknown[]) => h.budget(...a), meterBedrockCall: (...a: unknown[]) => h.meter(...a) }));
vi.mock("@/lib/ai-model", () => ({ languageModel: () => "model" }));
vi.mock("ai", async (orig) => ({
  ...(await orig<typeof import("ai")>()),
  streamText: (...a: unknown[]) => h.streamText(...a),
  generateText: (...a: unknown[]) => h.generateText(...a),
}));

import { POST as chat } from "./route";
import { POST as generate } from "./generate-data/route";

const chatReq = () => new Request("http://x/api/chat-builder", { method: "POST", body: JSON.stringify({ messages: [] }) });
const genReq = () => new Request("http://x/api/chat-builder/generate-data", {
  method: "POST", body: JSON.stringify({ description: "orders", config: { name: "n", description: "d", rules: [] } }),
});
const OVER = { ok: false, status: 402, scope: "team_month", error: "AI spend cap reached ($200.00 / $200 this month). Contact support." };

beforeEach(() => {
  vi.clearAllMocks();
  h.budget.mockResolvedValue({ ok: true });
  h.streamText.mockReturnValue({ toUIMessageStreamResponse: () => new Response("stream") });
  h.generateText.mockResolvedValue({ text: '[{"a":1}]', usage: { inputTokens: 10, outputTokens: 5 } });
});

describe("chat-builder AI metering for signed-in users", () => {
  it("checks the spend cap before streaming and meters the call on finish", async () => {
    expect((await chat(chatReq())).status).toBe(200);
    expect(h.budget).toHaveBeenCalledWith("user_1");
    const { onFinish } = h.streamText.mock.calls[0][0];
    await onFinish({ totalUsage: { inputTokens: 100, outputTokens: 20 } });
    expect(h.meter).toHaveBeenCalledWith(expect.objectContaining({ teamId: "user_1", runId: null, callType: "chat_builder", usage: { inputTokens: 100, outputTokens: 20 } }));
  });

  it("refuses with the cap message and never calls the model", async () => {
    h.budget.mockResolvedValue(OVER);
    const res = await chat(chatReq());
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe(OVER.error);
    expect(h.streamText).not.toHaveBeenCalled();
  });

  it("generate-data is capped and metered the same way", async () => {
    expect((await generate(genReq() as never)).status).toBe(200);
    expect(h.meter).toHaveBeenCalledWith(expect.objectContaining({ callType: "generate_data", usage: { inputTokens: 10, outputTokens: 5 } }));
    vi.clearAllMocks();
    h.budget.mockResolvedValue(OVER);
    expect((await generate(genReq() as never)).status).toBe(402);
    expect(h.generateText).not.toHaveBeenCalled();
  });
});
