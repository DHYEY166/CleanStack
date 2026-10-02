/**
 * TEST MODE ONLY: deterministic stand-in for Bedrock, used by languageModel()
 * when isTestMode() is true. Same prompt -> same answer, no network.
 *
 * It recognises the app's prompts by their section headings:
 * - suggest-transforms (tabular, "COLUMN-BY-COLUMN PROFILE"): trim_whitespace
 *   on all text columns, type_cast -> float for amount/price/total/cost
 *   columns (creates an __orig_* sidecar), normalize for date columns.
 * - suggest-transforms (document, "DOCUMENT PROFILE"): normalize_whitespace
 *   and remove_blank_lines.
 * - auto-validate committee prompts (mention rule ids): APPROVE every rule id.
 * - anything else (chat builder, data generator): a fixed text reply.
 */
import { MockLanguageModelV3 } from "ai/test";

type CallOptions = Parameters<MockLanguageModelV3["doGenerate"]>[0];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV3["doGenerate"]>>;

export const FAKE_MODEL_ID = "cleanstack-fake-model";
export const FAKE_TEXT_REPLY = "[fake-model] deterministic test response";

type Rule = { rule_type: string; column_name: string | null; parameters: Record<string, unknown>; ai_reasoning: string };

function promptText(options: CallOptions): string {
  const parts: string[] = [];
  for (const message of options.prompt) {
    if (typeof message.content === "string") parts.push(message.content);
    else for (const part of message.content) if (part.type === "text") parts.push(part.text);
  }
  return parts.join("\n");
}

export function fakeTabularRules(prompt: string): Rule[] {
  const columns = [...prompt.matchAll(/^Column: "([^"]+)"/gm)].map((m) => m[1]);
  const rules: Rule[] = [
    { rule_type: "trim_whitespace", column_name: null, parameters: {}, ai_reasoning: "[fake-model] trim surrounding whitespace in text columns." },
  ];
  for (const col of columns) {
    if (/amount|price|total|cost/i.test(col)) {
      rules.push({ rule_type: "type_cast", column_name: col, parameters: { target_type: "float" }, ai_reasoning: `[fake-model] cast ${col} to float.` });
    } else if (/date/i.test(col)) {
      rules.push({ rule_type: "normalize", column_name: col, parameters: {}, ai_reasoning: `[fake-model] normalize ${col} to YYYY-MM-DD.` });
    }
  }
  return rules;
}

export function fakeReply(prompt: string): string {
  if (prompt.includes("COLUMN-BY-COLUMN PROFILE")) return JSON.stringify({ rules: fakeTabularRules(prompt) });
  if (prompt.includes("DOCUMENT PROFILE")) {
    return JSON.stringify({
      rules: [
        { rule_type: "normalize_whitespace", column_name: null, parameters: {}, ai_reasoning: "[fake-model] normalize whitespace." },
        { rule_type: "remove_blank_lines", column_name: null, parameters: {}, ai_reasoning: "[fake-model] remove blank lines." },
      ],
    });
  }
  const ruleIds = [...new Set(prompt.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [])];
  if (/vote/i.test(prompt) && ruleIds.length) {
    return JSON.stringify({ votes: ruleIds.map((rule_id) => ({ rule_id, vote: "APPROVE", reason: "[fake-model] approve" })) });
  }
  return FAKE_TEXT_REPLY;
}

const usage = (prompt: string, reply: string): GenerateResult["usage"] => ({
  inputTokens: { total: Math.ceil(prompt.length / 4), noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: Math.ceil(reply.length / 4), text: undefined, reasoning: undefined },
});

export function createFakeModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: "cleanstack-test",
    modelId: FAKE_MODEL_ID,
    doGenerate: async (options) => {
      const prompt = promptText(options);
      const text = fakeReply(prompt);
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(prompt, text),
        warnings: [],
      };
    },
    doStream: async (options) => {
      const prompt = promptText(options);
      const text = fakeReply(prompt);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t0" });
            controller.enqueue({ type: "text-delta", id: "t0", delta: text });
            controller.enqueue({ type: "text-end", id: "t0" });
            controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(prompt, text) });
            controller.close();
          },
        }),
      };
    },
  });
}
