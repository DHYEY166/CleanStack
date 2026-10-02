import { afterEach, describe, expect, it } from "vitest";
import { generateText, Output, streamText } from "ai";
import { z } from "zod";
import { createFakeModel, FAKE_MODEL_ID, FAKE_TEXT_REPLY, fakeTabularRules } from "@/lib/fake-model";
import { languageModel } from "@/lib/ai-model";

const tabularPrompt = `## COLUMN-BY-COLUMN PROFILE
<user_data>
Column: "name"
  type: object
Column: "amount"
  type: object
Column: "order_date"
  type: object
</user_data>`;

describe("fake model", () => {
  it("returns the same tabular rules for the same prompt, matching the route's Output.object schema", async () => {
    const schema = z.object({ rules: z.array(z.object({ rule_type: z.string(), column_name: z.string().nullable(), parameters: z.record(z.string(), z.unknown()), ai_reasoning: z.string() })) });
    const a = await generateText({ model: createFakeModel(), output: Output.object({ schema }), prompt: tabularPrompt });
    const b = await generateText({ model: createFakeModel(), output: Output.object({ schema }), prompt: tabularPrompt });
    expect(a.output).toEqual(b.output);
    expect(a.output.rules.map((r) => [r.rule_type, r.column_name])).toEqual([
      ["trim_whitespace", null],
      ["type_cast", "amount"],
      ["normalize", "order_date"],
    ]);
    expect(a.usage.inputTokens).toBeGreaterThan(0);
  });

  it("approves every rule id in committee prompts", async () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const { text } = await generateText({ model: createFakeModel(), prompt: `Vote on rule_id ${id}` });
    expect(JSON.parse(text)).toEqual({ votes: [{ rule_id: id, vote: "APPROVE", reason: "[fake-model] approve" }] });
  });

  it("streams a fixed reply for free-form prompts", async () => {
    const result = streamText({ model: createFakeModel(), prompt: "hello" });
    expect(await result.text).toBe(FAKE_TEXT_REPLY);
  });

  it("only suggests type_cast/normalize for recognisable columns", () => {
    expect(fakeTabularRules('Column: "id"\nColumn: "city"')).toHaveLength(1);
  });
});

describe("languageModel()", () => {
  const saved = { flag: process.env.CLEANSTACK_TEST_MODE, vercel: process.env.VERCEL };
  afterEach(() => {
    if (saved.flag === undefined) delete process.env.CLEANSTACK_TEST_MODE; else process.env.CLEANSTACK_TEST_MODE = saved.flag;
    if (saved.vercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = saved.vercel;
  });
  const modelId = () => (languageModel() as { modelId: string }).modelId;

  it("is Bedrock outside test mode", () => {
    delete process.env.CLEANSTACK_TEST_MODE;
    expect(modelId()).toBe("us.anthropic.claude-sonnet-4-6");
  });
  it("is Bedrock when the test flag is set on Vercel", () => {
    process.env.CLEANSTACK_TEST_MODE = "1";
    process.env.VERCEL = "1";
    expect(modelId()).toBe("us.anthropic.claude-sonnet-4-6");
  });
  it("is the fake in test mode", () => {
    process.env.CLEANSTACK_TEST_MODE = "1";
    delete process.env.VERCEL;
    expect(modelId()).toBe(FAKE_MODEL_ID);
  });
});
