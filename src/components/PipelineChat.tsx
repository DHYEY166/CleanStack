"use client";

import { useRef, useEffect, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";

interface ParsedConfig {
  name: string;
  description: string;
  rules: Array<{
    rule_type: string;
    column_name: string | null;
    parameters: Record<string, unknown>;
    ai_reasoning: string;
  }>;
}

function extractConfig(text: string): ParsedConfig | null {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as ParsedConfig;
  } catch {
    return null;
  }
}

function stripJsonBlock(text: string): string {
  return text.replace(/```json[\s\S]*?```/g, "").trim();
}

interface PipelineChatProps {
  onApply: (name: string, description: string) => void;
}

export default function PipelineChat({ onApply }: PipelineChatProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState("");

  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat-builder" }),
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || status !== "ready") return;
    sendMessage({ text: input });
    setInput("");
  }

  // Find the last assistant message with a parseable config
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const lastText = lastAssistant?.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("") ?? "";
  const config = status === "ready" ? extractConfig(lastText) : null;

  const STARTERS = [
    "I have a HubSpot CSV with duplicate contacts and missing emails",
    "Shopify order export with mixed date formats and cancelled orders",
    "Bank statement with inconsistent categories and zero-value entries",
    "HR roster export with duplicate employee IDs and salary as text",
  ];

  return (
    <div className="flex flex-col h-[520px]">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-4 pr-1 pb-2">
        {messages.length === 0 && (
          <div className="space-y-3">
            <p className="text-gray-400 text-sm">
              Describe your data and I'll suggest a pipeline configuration.
            </p>
            <div className="grid grid-cols-1 gap-2">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    setInput(s);
                    inputRef.current?.focus();
                  }}
                  className="text-left text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 px-3 py-2 rounded-lg transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => {
          const text = m.parts
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("");
          const isAssistant = m.role === "assistant";
          const displayText = isAssistant ? stripJsonBlock(text) : text;

          return (
            <div key={m.id} className={`flex gap-3 ${isAssistant ? "" : "flex-row-reverse"}`}>
              <div
                className={`w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold ${
                  isAssistant ? "bg-indigo-600 text-white" : "bg-gray-700 text-gray-300"
                }`}
              >
                {isAssistant ? "AI" : "U"}
              </div>
              <div
                className={`max-w-[85%] rounded-xl px-4 py-2.5 text-sm leading-relaxed ${
                  isAssistant
                    ? "bg-gray-900 border border-gray-800 text-gray-200"
                    : "bg-indigo-600 text-white"
                }`}
              >
                {displayText || (isAssistant && status === "streaming" ? (
                  <span className="text-gray-500 animate-pulse">Thinking…</span>
                ) : null)}
              </div>
            </div>
          );
        })}

        {/* Streaming indicator */}
        {status === "streaming" && (
          <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full flex-shrink-0 bg-indigo-600 flex items-center justify-center text-xs font-bold text-white">
              AI
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-2.5">
              <div className="flex gap-1">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce"
                    style={{ animationDelay: `${i * 0.15}s` }}
                  />
                ))}
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Config preview + apply */}
      {config && (
        <div className="my-3 bg-indigo-500/10 border border-indigo-500/30 rounded-xl p-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex-1 min-w-0">
              <div className="text-indigo-300 font-medium text-sm truncate">{config.name}</div>
              <div className="text-gray-400 text-xs mt-0.5 truncate">{config.description}</div>
              <div className="text-gray-500 text-xs mt-1">{config.rules.length} rules suggested</div>
            </div>
            <button
              onClick={() => onApply(config.name, config.description)}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors flex-shrink-0"
            >
              Apply to Form →
            </button>
          </div>
        </div>
      )}

      {/* Input */}
      <form onSubmit={handleSend} className="flex gap-2 mt-auto">
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={status !== "ready"}
          placeholder="Describe your data quality problem…"
          className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 text-sm focus:outline-none focus:border-indigo-500 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!input.trim() || status !== "ready"}
          className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          Send
        </button>
      </form>
    </div>
  );
}
