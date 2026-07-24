/**
 * Chat contract types now live in `@infrawrench/client-core` so non-DOM hosts
 * (the mobile app) can use them without pulling in this component library.
 * Re-exported here so existing web/desktop imports keep working. Only the
 * DOM-coupled window-event helpers remain in this module.
 */
export type {
  ChatContentBlock,
  ChatConversationMessage,
  ChatPendingAction,
  ConversationSummary,
  ChatModelOption,
  SpendStatus,
  ChatTurnEvent,
  ChatConversationDetail,
  ChatClient,
} from "@infrawrench/client-core";
export { CHAT_MODELS, DEFAULT_CHAT_MODEL, microsToUsd } from "@infrawrench/client-core";

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
