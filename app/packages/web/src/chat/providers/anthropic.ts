/**
 * Anthropic (Claude) chat provider.
 *
 * Extracted verbatim from the original inline agent loop — the persisted
 * content-block format is Anthropic's, so this provider is a thin pass-through
 * apart from prompt-cache markers and usage normalization.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ChatContentBlock } from "@infrawrench/ui";
import type { ChatProvider, ProviderEvent, ProviderTool, TurnRequest } from "./types";

function toAnthropicTool(t: ProviderTool): Anthropic.Tool {
  return {
    name: t.name,
    description: t.description,
    input_schema: {
      type: "object",
      properties: t.inputSchema.properties as Record<string, Anthropic.Tool.InputSchema>,
      ...(t.inputSchema.required && t.inputSchema.required.length > 0
        ? { required: t.inputSchema.required }
        : {}),
    },
  };
}

/**
 * Strip anything another provider left behind.
 *
 * A conversation's model can be switched mid-thread, so history may hold blocks
 * Gemini produced. Anthropic rejects both unknown fields on a content block and
 * thinking signatures it didn't mint, so foreign thinking blocks are dropped
 * (assistant turns without them are accepted) and foreign tool_use blocks are
 * reduced to the fields Anthropic knows. tool_use must survive — dropping one
 * would orphan its paired tool_result.
 */
export function sanitizeForAnthropic(blocks: ChatContentBlock[]): ChatContentBlock[] {
  const out: ChatContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === "thinking") {
      if ((block.provider ?? "anthropic") === "anthropic") {
        out.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
      }
      continue;
    }
    if (block.type === "tool_use") {
      out.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      continue;
    }
    if (block.type === "text") {
      out.push({ type: "text", text: block.text });
      continue;
    }
    out.push(block);
  }
  return out;
}

export const anthropicProvider: ChatProvider = {
  label: "Anthropic",

  assertConfigured() {
    if (!process.env["ANTHROPIC_API_KEY"]) {
      throw new Error("ANTHROPIC_API_KEY not configured for this deployment");
    }
  },

  async *streamTurn(req: TurnRequest): AsyncGenerator<ProviderEvent> {
    const client = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] });

    const tools = req.tools.map(toAnthropicTool);
    // Prompt-cache the system prompt + tool definitions. Both are large and
    // stable across a session; the tool list is ~150kb of JSON Schema. Without
    // caching every turn pays full ingestion cost.
    const systemBlocks: Anthropic.TextBlockParam[] = [
      { type: "text", text: req.system, cache_control: { type: "ephemeral" } },
    ];
    if (tools.length > 0) {
      // Mark the last tool's schema with cache_control to checkpoint the entire
      // tools array — Anthropic's caching extends from the start of the prompt
      // through the most recent cache_control marker.
      const last = tools[tools.length - 1];
      if (last) {
        (last as Anthropic.Tool & { cache_control?: { type: "ephemeral" } }).cache_control = {
          type: "ephemeral",
        };
      }
    }

    const apiMessages: Anthropic.MessageParam[] = req.messages.map((m) => ({
      role: m.role,
      content: sanitizeForAnthropic(m.content) as Anthropic.ContentBlockParam[],
    }));

    let stopReason: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    const collectedBlocks: ChatContentBlock[] = [];
    let currentTextIdx = -1;
    const partialToolJson: Record<number, { id: string; name: string; json: string }> = {};
    // Stream index → collectedBlocks index for thinking blocks. They must be
    // persisted and echoed back verbatim (signature included) or the next
    // loop iteration's request is rejected.
    const thinkingIdx: Record<number, number> = {};

    const stream = await client.messages.stream({
      model: req.model,
      max_tokens: req.maxTokens,
      system: systemBlocks,
      tools,
      messages: apiMessages,
    });

    for await (const ev of stream) {
      if (ev.type === "content_block_start") {
        const block = ev.content_block;
        if (block.type === "text") {
          currentTextIdx = collectedBlocks.length;
          collectedBlocks.push({ type: "text", text: "" });
        } else if (block.type === "tool_use") {
          partialToolJson[ev.index] = { id: block.id, name: block.name, json: "" };
          yield { type: "tool_use_start", toolUseId: block.id, name: block.name };
        } else if (block.type === "thinking") {
          thinkingIdx[ev.index] = collectedBlocks.length;
          collectedBlocks.push({
            type: "thinking",
            thinking: "",
            signature: "",
            provider: "anthropic",
          });
        }
      } else if (ev.type === "content_block_delta") {
        const delta = ev.delta;
        if (delta.type === "text_delta") {
          yield { type: "text_delta", delta: delta.text };
          const last = collectedBlocks[currentTextIdx];
          if (last && last.type === "text") last.text += delta.text;
        } else if (delta.type === "thinking_delta" || delta.type === "signature_delta") {
          const tb = collectedBlocks[thinkingIdx[ev.index] ?? -1];
          if (tb && tb.type === "thinking") {
            if (delta.type === "thinking_delta") tb.thinking += delta.thinking;
            else tb.signature = delta.signature;
          }
        } else if (delta.type === "input_json_delta") {
          const acc = partialToolJson[ev.index];
          if (acc) {
            acc.json += delta.partial_json;
            yield { type: "tool_use_input", toolUseId: acc.id, partialJson: delta.partial_json };
          }
        }
      } else if (ev.type === "content_block_stop") {
        const acc = partialToolJson[ev.index];
        if (acc) {
          let parsedInput: Record<string, unknown> = {};
          try {
            parsedInput = acc.json ? (JSON.parse(acc.json) as Record<string, unknown>) : {};
          } catch {
            parsedInput = { __parse_error: acc.json };
          }
          collectedBlocks.push({
            type: "tool_use",
            id: acc.id,
            name: acc.name,
            input: parsedInput,
          });
        }
      } else if (ev.type === "message_delta") {
        if (ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
        if (ev.usage) outputTokens = ev.usage.output_tokens ?? outputTokens;
      } else if (ev.type === "message_start") {
        const usage = ev.message.usage;
        inputTokens = usage.input_tokens ?? 0;
        outputTokens = usage.output_tokens ?? 0;
        cacheReadTokens =
          (usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;
        cacheWriteTokens =
          (usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0;
      }
    }

    yield {
      type: "done",
      blocks: collectedBlocks,
      stopReason,
      usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
    };
  },
};
