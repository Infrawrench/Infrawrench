/**
 * Web implementation of the shared ChatClient: cookie-authenticated fetches
 * against /api/org/:orgId/chat, with the turn stream parsed from SSE frames.
 */
import type {
  ChatClient,
  ChatConversationDetail,
  ChatTurnEvent,
  ConversationSummary,
  SpendStatus,
} from "@infrawrench/ui";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";

export function createWebChatClient(orgId: string): ChatClient {
  const base = `/api/org/${orgId}/chat`;
  return {
    async listConversations() {
      const res = await apiGet<{ conversations: ConversationSummary[] }>(`${base}/conversations`);
      return res.conversations;
    },
    createConversation(model) {
      return apiPost<{ id: string }>(`${base}/conversations`, model ? { model } : {});
    },
    async setConversationModel(conversationId, model) {
      await apiPatch(`${base}/conversations/${conversationId}`, { model });
    },
    async archiveConversation(conversationId) {
      await apiDelete(`${base}/conversations/${conversationId}`);
    },
    getConversation(conversationId) {
      return apiGet<ChatConversationDetail>(`${base}/conversations/${conversationId}`);
    },
    getSpend() {
      return apiGet<SpendStatus>(`${base}/spend`);
    },
    async resolvePendingAction(conversationId, pendingId, action, reason) {
      await apiPost(`${base}/conversations/${conversationId}/pending/${pendingId}`, {
        action,
        ...(reason ? { reason } : {}),
      });
    },
    async submitSecretRequest(conversationId, requestId, value) {
      await apiPost(`${base}/conversations/${conversationId}/secret-requests/${requestId}`, {
        value,
      });
    },
    async *streamTurn(conversationId, body): AsyncIterable<ChatTurnEvent> {
      const res = await fetch(`${base}/conversations/${conversationId}/messages`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok || !res.body) {
        yield { type: "error", message: await res.text() };
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          // SSE frames are separated by a blank line.
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            // Parse SSE frame: event:<name>\ndata:<json>
            let dataLine = "";
            for (const ln of frame.split("\n")) {
              if (ln.startsWith("data:")) dataLine += ln.slice(5).trimStart();
            }
            if (!dataLine) continue;
            try {
              yield JSON.parse(dataLine) as ChatTurnEvent;
            } catch {
              continue;
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}
