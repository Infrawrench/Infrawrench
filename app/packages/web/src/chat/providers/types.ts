/**
 * Provider-neutral contract for one assistant turn.
 *
 * The chat agent loop (../agent.ts) is model-agnostic: it loads history, asks a
 * provider to stream one turn, then dispatches whatever tool_uses come back.
 * Everything model-specific — SDK wiring, tool schema dialect, streaming event
 * shapes, usage accounting — lives behind this interface.
 *
 * `ChatContentBlock` (Anthropic-shaped) stays the canonical persistence format
 * for message content regardless of provider. Non-Anthropic providers convert
 * to and from it at their boundary, so conversation history in the database has
 * one shape and the UI renderers don't branch on model.
 */
import type { ChatContentBlock } from "@infrawrench/ui";

/**
 * A tool as handed to a provider: name, description, and a JSON Schema object
 * for the input. Providers translate this into their own dialect.
 */
export interface ProviderTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Token counts for one turn, normalized across providers. */
interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface TurnRequest {
  model: string;
  system: string;
  tools: ProviderTool[];
  /** Conversation history, oldest first. */
  messages: Array<{ role: "user" | "assistant"; content: ChatContentBlock[] }>;
  maxTokens: number;
}

/**
 * Streaming events. A well-behaved provider yields any number of delta events
 * and finishes with exactly one `done` carrying the assembled message.
 */
export type ProviderEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_use_start"; toolUseId: string; name: string }
  | { type: "tool_use_input"; toolUseId: string; partialJson: string }
  | {
      type: "done";
      blocks: ChatContentBlock[];
      stopReason: string | null;
      usage: ProviderUsage;
    };

export interface ChatProvider {
  /** Human-readable name, used in error messages. */
  readonly label: string;
  /**
   * Throws with an actionable message when the deployment isn't configured for
   * this provider (missing key, missing project). Called before streaming so
   * the failure surfaces as a clean `error` event rather than mid-stream.
   */
  assertConfigured(): void;
  streamTurn(req: TurnRequest): AsyncGenerator<ProviderEvent>;
}
