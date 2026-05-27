/**
 * Thin provider-agnostic LLM client wrapper.
 *
 * All agent code MUST go through this interface. Nothing under src/agents/
 * may import the OpenAI SDK directly — only this module and its provider
 * implementation (src/llm/openai-provider.ts) touch the SDK.
 */
import type { z } from "zod";
import { OpenAIProvider } from "./openai-provider.js";
import { MockProvider } from "./mock-provider.js";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GenerateOptions {
  model: string;
  maxOutputTokens?: number;
  /** Reasoning effort for GPT-5.x reasoning models. */
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
}

/**
 * A tool the model may call during {@link LLMClient.generateWithTools}.
 *
 * `parameters` is a Zod schema; the provider parses raw model arguments
 * through it before calling `execute`. It is intentionally loosely typed
 * (`ZodTypeAny`) so schemas using `.default()`/`.optional()` — whose input
 * and output types differ — are accepted without variance friction.
 */
export interface LLMTool<Args = any> {
  name: string;
  description: string;
  parameters: z.ZodTypeAny;
  /** Executes the tool and returns a JSON-serializable result. */
  execute: (args: Args) => Promise<unknown>;
}

export interface ToolCallLogEntry {
  tool: string;
  args: unknown;
  result: unknown;
  error?: string;
}

export interface ToolRunResult<T> {
  output: T;
  toolLog: ToolCallLogEntry[];
}

export interface GenerateWithToolsOptions extends GenerateOptions {
  /** Hard cap on the number of tool invocations. */
  maxToolCalls: number;
}

export interface LLMClient {
  /** Single-call generation; returns the model's text. */
  generate(messages: LLMMessage[], options: GenerateOptions): Promise<string>;

  /** Single-call generation constrained to a Zod schema; returns parsed JSON. */
  generateStructured<T>(
    messages: LLMMessage[],
    schema: z.ZodType<T>,
    schemaName: string,
    options: GenerateOptions,
  ): Promise<T>;

  /**
   * Runs the function-calling loop until the model produces a final answer
   * matching `schema`. Returns the parsed output plus the full tool-call log.
   */
  generateWithTools<T>(
    messages: LLMMessage[],
    tools: LLMTool<any>[],
    schema: z.ZodType<T>,
    schemaName: string,
    options: GenerateWithToolsOptions,
  ): Promise<ToolRunResult<T>>;
}

let singleton: LLMClient | null = null;

/** True when the offline mock provider should be used. */
export function isMockMode(): boolean {
  return (
    process.env.LIT_SYNTH_MOCK === "1" || !process.env.OPENAI_API_KEY
  );
}

/**
 * Returns the process-wide LLM client. Uses the OpenAI provider when an API
 * key is present, otherwise falls back to the offline {@link MockProvider}
 * so the full pipeline still runs end-to-end (also forced by
 * LIT_SYNTH_MOCK=1).
 */
export function getLLMClient(): LLMClient {
  if (!singleton) {
    if (isMockMode()) {
      if (process.env.LIT_SYNTH_MOCK === "1") {
        console.error("[lit-synth] LIT_SYNTH_MOCK=1 — using offline mock LLM.");
      } else {
        console.error(
          "[lit-synth] OPENAI_API_KEY not set — using offline mock LLM (no real model calls).",
        );
      }
      singleton = new MockProvider();
    } else {
      singleton = new OpenAIProvider(process.env.OPENAI_API_KEY!);
    }
  }
  return singleton;
}
