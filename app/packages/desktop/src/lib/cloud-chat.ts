/**
 * Desktop implementation of the shared ChatClient. Every call goes over IPC to
 * the Electron main process, which proxies to the cloud web API with a Bearer
 * token (see electron/cloud-data/chat.ts). The turn stream arrives as events
 * on a per-stream channel (`cloud_chat_stream_<id>`) that this client adapts
 * into the AsyncIterable the shared chat UI consumes.
 */
import type {
  ChatClient,
  ChatConversationDetail,
  ChatTurnEvent,
  ConversationSummary,
  SpendStatus,
} from "@infrawrench/ui";
import { invoke } from "./invoke";

export function createDesktopChatClient(orgId: string): ChatClient {
  return {
    async listConversations() {
      const res = await invoke<{ conversations: ConversationSummary[] }>(
        "cloud_chat_list_conversations",
        { orgId },
      );
      return res.conversations;
    },
    createConversation() {
      return invoke<{ id: string }>("cloud_chat_create_conversation", { orgId });
    },
    async archiveConversation(conversationId) {
      await invoke("cloud_chat_archive_conversation", { orgId, conversationId });
    },
    getConversation(conversationId) {
      return invoke<ChatConversationDetail>("cloud_chat_get_conversation", {
        orgId,
        conversationId,
      });
    },
    getSpend() {
      return invoke<SpendStatus>("cloud_chat_spend", { orgId });
    },
    async resolvePendingAction(conversationId, pendingId, action, reason) {
      await invoke("cloud_chat_resolve_pending", {
        orgId,
        conversationId,
        pendingId,
        action,
        ...(reason ? { reason } : {}),
      });
    },
    async *streamTurn(conversationId, body): AsyncIterable<ChatTurnEvent> {
      const streamId = crypto.randomUUID();
      const channel = `cloud_chat_stream_${streamId}`;
      const queue: ChatTurnEvent[] = [];
      let wake: (() => void) | null = null;
      let done = false;

      window.electronAPI.on(channel, (ev) => {
        queue.push(ev as ChatTurnEvent);
        wake?.();
      });

      // The invoke resolves when the SSE stream ends; errors surface as
      // in-band {type:"error"} events from main, so this catch is a backstop.
      void invoke("cloud_chat_stream_start", { orgId, conversationId, streamId, body })
        .catch((e: unknown) => {
          queue.push({ type: "error", message: e instanceof Error ? e.message : String(e) });
        })
        .finally(() => {
          done = true;
          wake?.();
        });

      try {
        while (true) {
          while (queue.length > 0) yield queue.shift()!;
          if (done) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
      } finally {
        window.electronAPI.offAll(channel);
        // If the consumer bailed early, stop the upstream SSE fetch.
        if (!done) void invoke("cloud_chat_stream_abort", { streamId }).catch(() => {});
      }
    },
  };
}
