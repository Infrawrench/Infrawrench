/**
 * Bearer-token implementation of the shared ChatClient, for hosts that talk
 * to the cloud chat API directly over HTTPS (the mobile app). Mirrors the
 * web's cookie client (`web/src/lib/chat-client.ts`) and the desktop's IPC
 * proxy, but authenticates every call with the injected CloudFetch.
 */
import type { CloudFetch } from "../fetch";
import { parseSseStream } from "../sse";
import type {
  ChatClient,
  ChatConversationDetail,
  ChatTurnEvent,
  ConversationSummary,
  SpendStatus,
} from "./types";

export function createBearerChatClient(api: CloudFetch, orgId: string): ChatClient {
  const base = `/chat`;
  return {
    async listConversations() {
      const res = await api.org<{ conversations: ConversationSummary[] }>(
        orgId,
        `${base}/conversations`,
      );
      return res?.conversations ?? [];
    },
    async createConversation(model) {
      const res = await api.org<{ id: string }>(orgId, `${base}/conversations`, {
        method: "POST",
        body: JSON.stringify(model ? { model } : {}),
      });
      if (!res) throw new Error("Failed to create conversation");
      return res;
    },
    async setConversationModel(conversationId, model) {
      await api.org(orgId, `${base}/conversations/${conversationId}`, {
        method: "PATCH",
        body: JSON.stringify({ model }),
      });
    },
    async archiveConversation(conversationId) {
      await api.org(orgId, `${base}/conversations/${conversationId}`, { method: "DELETE" });
    },
    async getConversation(conversationId) {
      const res = await api.org<ChatConversationDetail>(
        orgId,
        `${base}/conversations/${conversationId}`,
      );
      if (!res) throw new Error("Conversation not found");
      return res;
    },
    async getSpend() {
      const res = await api.org<SpendStatus>(orgId, `${base}/spend`);
      if (!res) throw new Error("Failed to load spend");
      return res;
    },
    async resolvePendingAction(conversationId, pendingId, action, reason) {
      await api.org(orgId, `${base}/conversations/${conversationId}/pending/${pendingId}`, {
        method: "POST",
        body: JSON.stringify({ action, ...(reason ? { reason } : {}) }),
      });
    },
    async submitSecretRequest(conversationId, requestId, value) {
      await api.org(orgId, `${base}/conversations/${conversationId}/secret-requests/${requestId}`, {
        method: "POST",
        body: JSON.stringify({ value }),
      });
    },
    async *streamTurn(conversationId, body): AsyncIterable<ChatTurnEvent> {
      const res = await api.raw(
        `/api/org/${encodeURIComponent(orgId)}${base}/conversations/${conversationId}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok || !res.body) {
        yield { type: "error", message: await res.text().catch(() => "stream failed") };
        return;
      }
      yield* parseSseStream<ChatTurnEvent>(res.body);
    },
  };
}
