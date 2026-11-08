/**
 * Desktop implementation of the shared ChatClient.
 *
 * Every call but the turn is a typed call to the contract's `chat` domain
 * over the cloud transport (`./cloud-client.ts`). The turn's answer is
 * Server-Sent Events, which the buffered transport cannot carry, so it is the
 * `CloudChatTurn` RPC stream (`shared/rpc/groups/cloud-chat.ts`): the main
 * process sends it with the session's token and hands over each event as it
 * arrives, and this client adapts the stream into the AsyncIterable the
 * shared chat UI consumes. A turn that never started arrives as one `error`
 * event, as the server's own in-band errors do; leaving the iteration early
 * interrupts the stream, which cancels the fetch.
 */
import { Effect, Stream } from "effect";
import type {
  ChatClient,
  ChatConversationDetail,
  ChatTurnEvent,
  ConversationSummary,
  SpendStatus,
} from "@infrawrench/ui";
import { cloudClient } from "./cloud-client";
import { DesktopRpcClient, forkRpc, runRpc } from "./rpc/client";

const chat = () => cloudClient("chat").chat;

export function createDesktopChatClient(orgId: string): ChatClient {
  return {
    async listConversations(): Promise<ConversationSummary[]> {
      const res = await runRpc(chat().listConversations({ params: { orgId } }));
      return res.conversations;
    },
    createConversation(model) {
      return runRpc(
        chat().createConversation({ params: { orgId }, payload: model ? { model } : {} }),
      );
    },
    async setConversationModel(conversationId, model) {
      await runRpc(
        chat().updateConversation({ params: { orgId, conversationId }, payload: { model } }),
      );
    },
    async archiveConversation(conversationId) {
      await runRpc(chat().archiveConversation({ params: { orgId, conversationId } }));
    },
    getConversation(conversationId): Promise<ChatConversationDetail> {
      return runRpc(chat().getConversation({ params: { orgId, conversationId } }));
    },
    getSpend(): Promise<SpendStatus> {
      return runRpc(chat().spend({ params: { orgId } }));
    },
    async resolvePendingAction(conversationId, pendingId, action, reason) {
      await runRpc(
        chat().decidePending({
          params: { orgId, conversationId, pendingId },
          payload: { action, ...(reason ? { reason } : {}) },
        }),
      );
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
      const queue: ChatTurnEvent[] = [];
      let wake: (() => void) | null = null;
      let done = false;
      const notify = () => wake?.();

      const stop = forkRpc(
        Effect.gen(function* () {
          const rpc = yield* DesktopRpcClient;
          yield* Stream.runForEach(rpc.CloudChatTurn({ orgId, conversationId, body }), (event) =>
            Effect.sync(() => {
              queue.push(event);
              notify();
            }),
          );
        }).pipe(
          // A turn that never started is the turn's error, shown like the
          // server's own in-band `error` events.
          Effect.catch((error) =>
            Effect.sync(() => {
              queue.push({ type: "error", message: error.message });
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              done = true;
              notify();
            }),
          ),
        ),
      );

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
        // If the consumer bailed early, stop the upstream SSE fetch.
        if (!done) stop();
      }
    },
  };
}
