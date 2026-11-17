/**
 * Anthropic (Claude) chat provider.
 *
 * The persisted content-block format is Anthropic's, so this provider is a
 * thin pass-through apart from prompt-cache markers and usage normalization.
 * The client comes from server-core's anthropic-client, which routes through
 * Cloudflare AI Gateway in production.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  ANTHROPIC_NOT_CONFIGURED,
  anthropicClient,
  isAnthropicConfigured,
} from "@infrawrench/server-core/anthropic-client";
import type { ServerToolBlock, StoredChatBlock } from "../server-blocks";
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
 * Anthropic's server-side tool search, BM25 flavour: the model describes what
 * it needs in words ("create a DigitalOcean droplet") and the API loads the
 * best matches into context. The search runs inside the same response and is
 * not metered separately; a tool it loads bills as ordinary input.
 */
export const TOOL_SEARCH_TOOL: Anthropic.ToolSearchToolBm25_20251119 = {
  type: "tool_search_tool_bm25_20251119",
  name: "tool_search_tool_bm25",
};

/**
 * The `tools` array for one request.
 *
 * The registry is over a thousand tools (every plugin's `<plugin>_create_<type>`
 * among them), roughly 600K tokens of schema, so sending it all as context made
 * the first message of a conversation cost dollars in cache writes alone.
 * Deferred tools are still sent, since the API searches and expands them
 * server-side, but stay out of the prompt until a search loads them. The search
 * tool goes in only when something is deferred, because at least one tool must
 * not be.
 *
 * The cache marker sits on the last tool that loads up front: a deferred tool
 * may not carry one (400), and deferred tools are outside the cached prefix
 * anyway, so their order and count never invalidate it.
 */
export function anthropicTools(tools: readonly ProviderTool[]): Anthropic.ToolUnion[] {
  const loaded: Anthropic.Tool[] = [];
  const deferred: Anthropic.Tool[] = [];
  for (const t of tools) {
    if (t.deferLoading) deferred.push({ ...toAnthropicTool(t), defer_loading: true });
    else loaded.push(toAnthropicTool(t));
  }
  const last = loaded[loaded.length - 1];
  if (last) last.cache_control = { type: "ephemeral" };
  return [...(deferred.length > 0 ? [TOOL_SEARCH_TOOL] : []), ...loaded, ...deferred];
}

/**
 * Strip anything another provider left behind.
 *
 * Chat used to offer Gemini, and conversations that ran on it were moved to
 * Claude with their history intact, so stored history can hold blocks Gemini
 * produced. Anthropic rejects both unknown fields on a content block and
 * thinking signatures it didn't mint, so foreign thinking blocks are dropped
 * (assistant turns without them are accepted) and foreign tool_use blocks are
 * reduced to the fields Anthropic knows. tool_use must survive: dropping one
 * would orphan its paired tool_result.
 */
export function sanitizeForAnthropic(blocks: StoredChatBlock[]): StoredChatBlock[] {
  const out: StoredChatBlock[] = [];
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

/**
 * True for the 400 a replayed thinking block gets once the conversation it was
 * written in has changed: Sonnet 5.5 and Opus 5.5 bind each block to the
 * system prompt, tool set and earlier messages it saw. Here that happens when
 * the system prompt moves between turns (a canvas conversation carries the
 * canvas into it) or the organization's offered tools change.
 */
function isThinkingBindingMismatch(err: unknown): boolean {
  return (
    err instanceof Anthropic.BadRequestError &&
    err.message.includes("bound to a different conversation")
  );
}

/**
 * History without its thinking blocks. The API's documented recovery for a
 * binding mismatch: the turn runs without the earlier reasoning, and text and
 * tool_use blocks (which tool_results pair with) are untouched. Stored history
 * keeps the blocks; only this request goes without them.
 */
function withoutThinking(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  return messages.map((m) =>
    typeof m.content === "string"
      ? m
      : {
          ...m,
          content: m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking"),
        },
  );
}

export const anthropicProvider: ChatProvider = {
  label: "Anthropic",

  assertConfigured() {
    if (!isAnthropicConfigured()) throw new Error(ANTHROPIC_NOT_CONFIGURED);
  },

  async *streamTurn(req: TurnRequest): AsyncGenerator<ProviderEvent> {
    const client = anthropicClient();

    // Three cache breakpoints: the last up-front tool (in `anthropicTools`),
    // the system prompt, and the top-level automatic one below, which follows
    // the end of the conversation. Without that last one every iteration of
    // the agent loop paid full input price for the whole history again.
    const tools = anthropicTools(req.tools);
    const systemBlocks: Anthropic.TextBlockParam[] = [
      { type: "text", text: req.system, cache_control: { type: "ephemeral" } },
    ];

    const apiMessages: Anthropic.MessageParam[] = req.messages.map((m) => ({
      role: m.role,
      content: sanitizeForAnthropic(m.content) as Anthropic.ContentBlockParam[],
    }));

    let stopReason: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    const collectedBlocks: StoredChatBlock[] = [];
    let currentTextIdx = -1;
    const partialToolJson: Record<number, { id: string; name: string; json: string }> = {};
    // Tool search calls, kept whole (every field the API sent) so they replay
    // unchanged; only `input` arrives later, as deltas.
    const partialServerTool: Record<number, { block: object; json: string }> = {};
    // Stream index → collectedBlocks index for thinking blocks. They must be
    // persisted and echoed back verbatim (signature included) or the next
    // loop iteration's request is rejected.
    const thinkingIdx: Record<number, number> = {};

    const open = (messages: Anthropic.MessageParam[]) =>
      client.messages.stream({
        model: req.model,
        max_tokens: req.maxTokens,
        system: systemBlocks,
        tools,
        messages,
        cache_control: { type: "ephemeral" },
      });
    async function* events() {
      let started = false;
      try {
        for await (const ev of open(apiMessages)) {
          started = true;
          yield ev;
        }
        return;
      } catch (err) {
        // The binding check runs before any output, so a rejection here has
        // shown the user nothing and the retry repeats nothing.
        if (started || !isThinkingBindingMismatch(err)) throw err;
      }
      yield* open(withoutThinking(apiMessages));
    }

    for await (const ev of events()) {
      if (ev.type === "content_block_start") {
        const block = ev.content_block;
        if (block.type === "text") {
          currentTextIdx = collectedBlocks.length;
          collectedBlocks.push({ type: "text", text: "" });
        } else if (block.type === "tool_use") {
          partialToolJson[ev.index] = { id: block.id, name: block.name, json: "" };
          yield { type: "tool_use_start", toolUseId: block.id, name: block.name };
        } else if (block.type === "server_tool_use") {
          partialServerTool[ev.index] = { block, json: "" };
        } else if (block.type === "tool_search_tool_result") {
          collectedBlocks.push(block as unknown as ServerToolBlock);
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
          const server = partialServerTool[ev.index];
          if (server) server.json += delta.partial_json;
        }
      } else if (ev.type === "content_block_stop") {
        const server = partialServerTool[ev.index];
        if (server) {
          let input: unknown = {};
          try {
            input = server.json ? JSON.parse(server.json) : {};
          } catch {
            // Replaying a search the API ran is all this block is for; an
            // unparseable query only means it replays as an empty one.
          }
          collectedBlocks.push({ ...server.block, input } as ServerToolBlock);
        }
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
