/**
 * OpenAI implementation of {@link LLMClient}.
 *
 * This is the ONLY file outside of src/llm/ that is allowed to import the
 * OpenAI SDK. GPT-5.x reasoning models are used:
 *   - Agent 2 (screening): gpt-5.4-mini   (smallest current frontier model)
 *   - Agent 3 (synthesis):  gpt-5.4        (strongest current model)
 * Model IDs are chosen by the caller; this provider just adapts the SDK.
 *
 * Reasoning-model API notes handled here:
 *   - use `max_completion_tokens`, never `max_tokens`
 *   - do NOT send a custom `temperature` (reasoning models reject non-default)
 *   - `reasoning_effort` is forwarded when supplied
 */
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { z } from "zod";
import type {
  GenerateOptions,
  GenerateWithToolsOptions,
  LLMClient,
  LLMMessage,
  LLMTool,
  ToolCallLogEntry,
  ToolRunResult,
} from "./client.js";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export class OpenAIProvider implements LLMClient {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  // Loosely typed: GPT-5.x reasoning params (max_completion_tokens,
  // reasoning_effort) are passed through and the SDK request types are too
  // strict about the exact literal shape to spread cleanly.
  private baseParams(options: GenerateOptions): Record<string, any> {
    const params: Record<string, any> = { model: options.model };
    if (options.maxOutputTokens) {
      params.max_completion_tokens = options.maxOutputTokens;
    }
    if (options.reasoningEffort) {
      params.reasoning_effort = options.reasoningEffort;
    }
    return params;
  }

  async generate(
    messages: LLMMessage[],
    options: GenerateOptions,
  ): Promise<string> {
    const resp = await this.client.chat.completions.create({
      ...this.baseParams(options),
      messages: messages as ChatMessage[],
    } as any);
    return resp.choices[0]?.message?.content ?? "";
  }

  async generateStructured<T>(
    messages: LLMMessage[],
    schema: z.ZodType<T>,
    schemaName: string,
    options: GenerateOptions,
  ): Promise<T> {
    // openai v4: the structured-output parse helper lives under `beta`.
    const completion = await this.client.beta.chat.completions.parse({
      ...this.baseParams(options),
      messages: messages as ChatMessage[],
      response_format: zodResponseFormat(schema as z.ZodTypeAny, schemaName),
    } as any);

    const msg = completion.choices[0]?.message;
    if (msg?.refusal) {
      throw new Error(`Model refused the request: ${msg.refusal}`);
    }
    const parsed = msg?.parsed;
    if (parsed == null) {
      throw new Error("Model returned no structured output.");
    }
    return parsed as T;
  }

  async generateWithTools<T>(
    messages: LLMMessage[],
    tools: LLMTool<any>[],
    schema: z.ZodType<T>,
    schemaName: string,
    options: GenerateWithToolsOptions,
  ): Promise<ToolRunResult<T>> {
    const convo: ChatMessage[] = [...(messages as ChatMessage[])];
    const toolLog: ToolCallLogEntry[] = [];
    const responseFormat = zodResponseFormat(
      schema as z.ZodTypeAny,
      schemaName,
    );

    const toolDefs: OpenAI.Chat.Completions.ChatCompletionTool[] = tools.map(
      (t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: zodToJsonSchema(t.parameters, {
            target: "openAi",
          }) as Record<string, unknown>,
        },
      }),
    );
    const byName = new Map(tools.map((t) => [t.name, t]));

    let toolCallsUsed = 0;
    // A generous iteration ceiling; the real budget is `maxToolCalls`.
    const maxIterations = options.maxToolCalls + 4;

    for (let iter = 0; iter < maxIterations; iter++) {
      const budgetExhausted = toolCallsUsed >= options.maxToolCalls;
      const completion = await this.client.chat.completions.create({
        ...this.baseParams(options),
        messages: convo,
        response_format: responseFormat,
        // Once the tool budget is spent, stop offering tools so the model
        // is forced to produce its final structured answer.
        ...(budgetExhausted
          ? {}
          : { tools: toolDefs, tool_choice: "auto" }),
      } as any);

      const choice = completion.choices[0];
      const msg = choice?.message;
      if (!msg) throw new Error("Model returned no message.");

      const toolCalls = msg.tool_calls ?? [];
      if (toolCalls.length > 0 && !budgetExhausted) {
        convo.push({
          role: "assistant",
          content: msg.content ?? "",
          tool_calls: toolCalls,
        });

        for (const call of toolCalls) {
          if (call.type !== "function") continue;
          const tool = byName.get(call.function.name);
          let resultPayload: unknown;
          let errMsg: string | undefined;

          if (!tool) {
            errMsg = `Unknown tool: ${call.function.name}`;
            resultPayload = { error: errMsg };
          } else if (toolCallsUsed >= options.maxToolCalls) {
            errMsg = "Tool-call budget exhausted.";
            resultPayload = { error: errMsg };
          } else {
            toolCallsUsed++;
            try {
              const rawArgs = JSON.parse(call.function.arguments || "{}");
              const args = tool.parameters.parse(rawArgs);
              resultPayload = await tool.execute(args);
            } catch (e) {
              errMsg = e instanceof Error ? e.message : String(e);
              resultPayload = { error: errMsg };
            }
            toolLog.push({
              tool: call.function.name,
              args: safeJson(call.function.arguments),
              result: resultPayload,
              ...(errMsg ? { error: errMsg } : {}),
            });
          }

          convo.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(resultPayload),
          });
        }
        continue;
      }

      // No tool calls (or budget exhausted): expect the final structured answer.
      const content = msg.content ?? "";
      const output = parseStructured(content, schema);
      if (output !== undefined) {
        return { output, toolLog };
      }

      // Model produced neither a tool call nor parseable output. Nudge it
      // explicitly toward the schema and try once more.
      convo.push({
        role: "assistant",
        content: content || "(no content)",
      });
      convo.push({
        role: "user",
        content:
          "Return ONLY the final answer as JSON matching the required schema. Do not call any tools.",
      });
    }

    // Final forced attempt without tools.
    const finalCompletion = await this.client.beta.chat.completions.parse({
      ...this.baseParams(options),
      messages: convo,
      response_format: responseFormat,
    } as any);
    const finalParsed = finalCompletion.choices[0]?.message?.parsed;
    if (finalParsed == null) {
      throw new Error(
        "Model did not produce a valid final answer after the tool loop.",
      );
    }
    return { output: finalParsed as T, toolLog };
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Parses model content into the schema, returning undefined on failure. */
function parseStructured<T>(
  content: string,
  schema: z.ZodType<T>,
): T | undefined {
  if (!content.trim()) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    // Tolerate fenced code blocks.
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (!match) return undefined;
    try {
      json = JSON.parse(match[1]!);
    } catch {
      return undefined;
    }
  }
  const result = schema.safeParse(json);
  return result.success ? result.data : undefined;
}
