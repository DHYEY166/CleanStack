/**
 * The language model every AI route calls. Production: Amazon Bedrock with
 * BEDROCK_MODEL_ID. TEST MODE ONLY (src/lib/test-mode.ts): a deterministic
 * in-process fake (src/lib/fake-model.ts), so CI never reaches AWS.
 */
import type { LanguageModel } from "ai";
import { bedrock } from "@ai-sdk/amazon-bedrock";
import { BEDROCK_MODEL_ID } from "@/lib/ai-config";
import { createFakeModel } from "@/lib/fake-model";
import { isTestMode } from "@/lib/test-mode";

export function languageModel(): LanguageModel {
  return isTestMode() ? createFakeModel() : bedrock(BEDROCK_MODEL_ID);
}
