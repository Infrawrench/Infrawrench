export type ContentBlock =
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

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: ContentBlock[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  stopReason: string | null;
  createdAt: string;
}

export interface PendingAction {
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
