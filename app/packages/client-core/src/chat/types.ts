/**
 * Shared types for the org-level cloud chat (Claude agent). The server side
 * lives in the web package (`/api/org/:orgId/chat`); web talks to it with
 * session-cookie fetches, desktop proxies through the Electron main process
 * with a Bearer token, and mobile fetches with a Bearer token directly. All
 * hosts render chat UIs parameterized by a `ChatClient`.
 *
 * Moved here from `@infrawrench/ui` so non-DOM hosts (React Native) can use
 * the contract without pulling in the web component library; ui re-exports
 * these for backwards compatibility.
 */

import type { AskQuestionAnswer } from "./ask-question";

/**
 * Which provider minted a block's opaque signature. A conversation's model can
 * be changed mid-thread (PATCH /conversations/:id), so history routinely mixes
 * providers — and a thought signature is only valid to the provider that
 * issued it. Blocks written before this field existed are Anthropic's, which is
 * why `undefined` means Anthropic rather than "unknown".
 */
export type ChatBlockProvider = "anthropic" | "gemini";

export type ChatContentBlock =
  | {
      type: "text";
      text: string;
      /**
       * Gemini only. Gemini 3 can attach a thought signature to a plain text
       * part — a reply may carry reasoning tokens and a signature with no
       * separate thought part at all — and it has to come back on the next
       * request for the reasoning context to survive the turn. Stripped before
       * the block reaches any other provider; renderers ignore it.
       */
      signature?: string;
      provider?: ChatBlockProvider;
    }
  | {
      // Opus 5+ thinks by default; the block must be echoed back to the API
      // unchanged on later loop iterations (text is empty unless the request
      // opts into display: "summarized"). Renderers skip it.
      type: "thinking";
      thinking: string;
      signature: string;
      provider?: ChatBlockProvider;
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
      /**
       * Gemini only. Gemini 3 attaches a thought signature to the function-call
       * part itself (not just to thinking blocks), and rejects the follow-up
       * request if it isn't echoed back. Stripped before the block is sent to
       * any other provider.
       */
      signature?: string;
      provider?: ChatBlockProvider;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | Array<{ type: "text"; text: string }>;
      is_error?: boolean;
    };

export interface ChatConversationMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: ChatContentBlock[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  stopReason: string | null;
  createdAt: string;
}

export interface ChatPendingAction {
  id: string;
  conversationId: string;
  messageId: string;
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "executed" | "errored";
  result: string | null;
  isError: boolean;
  resolvedAt: string | null;
  createdAt: string;
}

/**
 * Metadata for a workflow secret value that must be supplied directly by a
 * human. The value is never part of this contract.
 */
export interface ChatPendingSecretRequest {
  id: string;
  conversationId: string;
  messageId: string;
  toolUseId: string;
  secretId: string | null;
  name: string;
  title: string | null;
  description: string | null;
  status: "pending" | "submitting" | "stored";
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Models the chat can run on. Shared between the picker UI and the server
 * (which validates the create-conversation body against these ids and prices
 * each one in web/src/chat/pricing.ts).
 */
export interface ChatModelOption {
  id: string;
  label: string;
  description: string;
}

export const CHAT_MODELS: ChatModelOption[] = [
  {
    id: "gemini-3.6-flash",
    label: "Gemini 3.6 Flash",
    description: "Fast and inexpensive — the default for most chats",
  },
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    description: "Balanced — near-Opus quality at lower cost",
  },
  {
    id: "claude-opus-5",
    label: "Claude Opus 5",
    description: "Most capable — best for complex, multi-step infrastructure work",
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    description: "Fastest and cheapest — quick lookups",
  },
];

export const DEFAULT_CHAT_MODEL = "gemini-3.6-flash";

export interface SpendStatus {
  monthToDateMicros: number;
  monthlyCapMicros: number | null;
  /** True when capMicros is set and monthToDateMicros >= capMicros. */
  exceeded: boolean;
  /**
   * True when the cap comes from the free tier (no paid subscription) rather
   * than an org-configured cap.
   */
  freeTier: boolean;
  /**
   * True when the org has platform-granted complimentary access: all paid
   * perks, never billed, uncapped by default. Optional so clients tolerate
   * servers that predate the field.
   */
  complimentary?: boolean;
}

export function microsToUsd(micros: number): string {
  return (micros / 1_000_000).toFixed(2);
}

/**
 * One server-sent event from `POST /conversations/:id/messages`. Kept loose on
 * purpose: hosts forward the parsed SSE `data:` JSON as-is.
 */
export interface ChatTurnEvent {
  type:
    | "text_delta"
    | "tool_use_start"
    | "tool_use_input"
    | "tool_executed"
    | "pending_action"
    | "secret_request"
    | "sleep"
    | "turn_end"
    | "spend_blocked"
    | "error";
  [key: string]: unknown;
}

/** One in-flight tool call, accumulated from `tool_use_*` turn events. */
export interface ChatStreamingToolUse {
  id: string;
  name: string;
  /** Input JSON, concatenated from `tool_use_input` deltas. Surfaces that don't render inputs leave it empty. */
  input: string;
  executed?: boolean;
}

/**
 * View state a surface accumulates while a turn streams — the reduction of
 * {@link ChatTurnEvent}s every chat host performs. Declared here so the web,
 * desktop and mobile reducers agree on what a turn in flight looks like.
 */
export interface ChatStreamingState {
  active: boolean;
  /** Optimistic echo of the user message just sent, until the reload swaps in the persisted copy. */
  userText?: string | undefined;
  /** Buffered text for the in-flight assistant message. */
  text: string;
  toolUses: ChatStreamingToolUse[];
  error?: string | undefined;
}

export interface ChatConversationDetail {
  conversation: ConversationSummary;
  messages: ChatConversationMessage[];
  pendingActions: ChatPendingAction[];
  pendingSecretRequests: ChatPendingSecretRequest[];
}

/**
 * Host-provided data access for the cloud chat. Web implements it with
 * cookie-authenticated fetches; desktop over Electron IPC; mobile with the
 * Bearer client in `./bearer-client`.
 */
export interface ChatClient {
  listConversations(): Promise<ConversationSummary[]>;
  createConversation(model?: string): Promise<{ id: string }>;
  /** Change the model an existing conversation runs on (takes effect next turn). */
  setConversationModel(conversationId: string, model: string): Promise<void>;
  archiveConversation(conversationId: string): Promise<void>;
  getConversation(conversationId: string): Promise<ChatConversationDetail>;
  getSpend(): Promise<SpendStatus>;
  resolvePendingAction(
    conversationId: string,
    pendingId: string,
    action: "approve" | "reject",
    reason?: string,
  ): Promise<void>;
  /** Submit a secret directly to encrypted storage; the value is never returned. */
  submitSecretRequest(conversationId: string, requestId: string, value: string): Promise<void>;
  /** Answer an `ask_question` pending action and resume when every sibling is resolved. */
  answerQuestion(
    conversationId: string,
    pendingId: string,
    answers: AskQuestionAnswer[],
  ): Promise<void>;
  /** Run one agent turn; yields SSE events until the turn ends or errors. */
  streamTurn(
    conversationId: string,
    body: { text?: string; resume?: boolean },
  ): AsyncIterable<ChatTurnEvent>;
}
