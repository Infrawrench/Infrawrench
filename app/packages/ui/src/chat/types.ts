/**
 * Shared types for the org-level cloud chat (Claude agent). The server side
 * lives in the web package (`/api/org/:orgId/chat`); web talks to it with
 * session-cookie fetches while desktop proxies through the Electron main
 * process with a Bearer token. Both render the same components from this
 * module, parameterized by a `ChatClient`.
 */

export type ChatContentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
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

export interface ConversationSummary {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

export interface SpendStatus {
  monthToDateMicros: number;
  monthlyCapMicros: number | null;
  /** True when capMicros is set and monthToDateMicros >= capMicros. */
  exceeded: boolean;
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
    | "turn_end"
    | "spend_blocked"
    | "error";
  [key: string]: unknown;
}

export interface ChatConversationDetail {
  conversation: ConversationSummary;
  messages: ChatConversationMessage[];
  pendingActions: ChatPendingAction[];
}

/**
 * Host-provided data access for the cloud chat. Web implements it with
 * cookie-authenticated fetches; desktop implements it over Electron IPC where
 * the main process calls the cloud API with a Bearer token.
 */
export interface ChatClient {
  listConversations(): Promise<ConversationSummary[]>;
  createConversation(): Promise<{ id: string }>;
  archiveConversation(conversationId: string): Promise<void>;
  getConversation(conversationId: string): Promise<ChatConversationDetail>;
  getSpend(): Promise<SpendStatus>;
  resolvePendingAction(
    conversationId: string,
    pendingId: string,
    action: "approve" | "reject",
    reason?: string,
  ): Promise<void>;
  /** Run one agent turn; yields SSE events until the turn ends or errors. */
  streamTurn(
    conversationId: string,
    body: { text?: string; resume?: boolean },
  ): AsyncIterable<ChatTurnEvent>;
}

/**
 * Window event fired whenever chat conversations change (created, archived,
 * renamed, or a turn completes) so session lists can refresh.
 */
export const CHAT_CONVERSATIONS_CHANGED_EVENT = "infrawrench:chat-conversations-changed";

export function emitChatConversationsChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(CHAT_CONVERSATIONS_CHANGED_EVENT));
  }
}
