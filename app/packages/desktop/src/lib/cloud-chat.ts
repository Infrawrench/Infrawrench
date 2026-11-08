/**
 * Desktop implementation of the shared ChatClient.
 *
 * Archiving, answering a question and handing over a secret are typed calls
 * to the contract's `chat` domain over the cloud transport
 * (`./cloud-client.ts`). The rest still goes over per-channel IPC to the main
 * process (electron/cloud-data/chat.ts), because the contract cannot carry
 * them yet: the conversation reads and the spend declare their success as
 * `Schema.Unknown`, and creating a conversation, switching its model and
 * deciding a pending action declare no payload although the routes read one.
 * The turn stream arrives as events on a per-stream channel
 * (`cloud_chat_stream_<id>`) that this client adapts into the AsyncIterable
 * the shared chat UI consumes.
 */
import type {
  ChatClient,
  ChatConversationDetail,
  ChatTurnEvent,
  ConversationSummary,
  SpendStatus,
} from "@infrawrench/ui";
import { cloudClient } from "./cloud-client";
import { invoke } from "./invoke";
import { runRpc } from "./rpc/client";

const chat = () => cloudClient("chat").chat;

export function createDesktopChatClient(orgId: string): ChatClient {
  return {
    async listConversations() {
      const res = await invoke<{ conversations: ConversationSummary[] }>(
        "cloud_chat_list_conversations",
        { orgId },
      );
      return res.conversations;
    },
    createConversation(model) {
      return invoke<{ id: string }>("cloud_chat_create_conversation", {
        orgId,
        ...(model ? { model } : {}),
      });
    },
    async setConversationModel(conversationId, model) {
      await invoke("cloud_chat_update_conversation", { orgId, conversationId, model });
    },
    async archiveConversation(conversationId) {
      await runRpc(chat().archiveConversation({ params: { orgId, conversationId } }));
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
    async submitSecretRequest(conversationId, requestId, value) {
      await runRpc(
        chat().submitSecretRequest({
          params: { orgId, conversationId, requestId },
          payload: { value },
        }),
      );
    },
    async answerQuestion(conversationId, pendingId, answers) {
      await runRpc(
        chat().answerQuestion({
          params: { orgId, conversationId, pendingId },
          payload: { answers },
        }),
      );
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
