import { convertToModelMessages, streamText, UIMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

export const maxDuration = 60;

const SYSTEM = `You are a data pipeline configuration expert for CleanStack, a data quality platform.

When a user describes their data, respond conversationally explaining what you'll do, then output a JSON config block.

Supported rule types: drop_nulls, deduplicate, type_cast, rename, filter, normalize, fill_nulls, trim_whitespace

Always end your response with exactly one fenced JSON block:
\`\`\`json
{
  "name": "<concise pipeline name>",
  "description": "<one sentence describing what this pipeline cleans>",
  "rules": [
    {
      "rule_type": "<rule_type>",
      "column_name": "<column or null for table-level rules>",
      "parameters": {},
      "ai_reasoning": "<one sentence explaining why>"
    }
  ]
}
\`\`\`

Suggest 4–7 rules ordered by impact. Be specific about column names the user mentions.
If no column names are given, use realistic guesses based on the data type described.`;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: anthropic("claude-sonnet-4-6"),
    system: SYSTEM,
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}
