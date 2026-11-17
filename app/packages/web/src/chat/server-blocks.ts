/**
 * Content blocks the Anthropic API writes for its own server-side tools, which
 * chat stores but never shows.
 *
 * Chat offers most of the tool registry behind Anthropic's tool search
 * (`./providers/anthropic.ts`): the model searches, the API answers inside the
 * same response with a `server_tool_use` / `tool_search_tool_result` pair, and
 * the found tools load into context. The pair has to be replayed unchanged on
 * every later request, or the tools it loaded are gone, so it is persisted with
 * the assistant message like any other block.
 *
 * It is plumbing, though, not conversation: no renderer has anything to show
 * for it, and the HTTP contract's `ChatContentBlock` (client-core) does not
 * describe it. The conversation route drops it on the way out
 * ({@link withoutServerToolBlocks}), so the API surface and every client stay
 * as they were.
 */
import type { ChatContentBlock } from "@infrawrench/client-core";

export type ServerToolBlock =
  | {
      type: "server_tool_use";
      id: string;
      name: string;
      input: unknown;
    }
  | {
      type: "tool_search_tool_result";
      tool_use_id: string;
      /** The API's search result (or error) object, replayed as it came. */
      content: unknown;
    };

/** A block as stored in `chat_messages.content` and sent back to the model. */
export type StoredChatBlock = ChatContentBlock | ServerToolBlock;

const SERVER_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "server_tool_use",
  "tool_search_tool_result",
]);

/**
 * `content` from a stored message without the server-tool blocks, for the
 * conversation API. Anything that is not an array passes through untouched.
 */
export function withoutServerToolBlocks(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.filter(
    (block: unknown) =>
      !(
        typeof block === "object" &&
        block !== null &&
        SERVER_BLOCK_TYPES.has(String((block as { type?: unknown }).type))
      ),
  );
}
