import { useCallback, useEffect, useState } from "react";
import {
  CHAT_CONVERSATIONS_CHANGED_EVENT,
  emitChatConversationsChanged,
  type ChatClient,
  type ConversationSummary,
} from "./types.js";

interface Props {
  client: ChatClient;
  onOpen(conversationId: string): void;
}

/** Conversation list with new-chat and archive — the chat "home" page. */
export function ChatListView({ client, onOpen }: Props): React.ReactElement {
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);

  const load = useCallback(async () => {
    setConversations(await client.listConversations());
  }, [client]);

  useEffect(() => {
    void load();
    const handler = () => void load();
    window.addEventListener(CHAT_CONVERSATIONS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(CHAT_CONVERSATIONS_CHANGED_EVENT, handler);
  }, [load]);

  async function handleNew(): Promise<void> {
    const res = await client.createConversation();
    emitChatConversationsChanged();
    onOpen(res.id);
  }

  async function handleArchive(id: string): Promise<void> {
    await client.archiveConversation(id);
    emitChatConversationsChanged();
    await load();
  }

  return (
    <div className="max-w-3xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">Chat</h1>
        <button
          type="button"
          onClick={() => void handleNew()}
          className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
        >
          New chat
        </button>
      </div>

      {conversations === null ? (
        <p className="text-sm text-on-surface-faint">Loading…</p>
      ) : conversations.length === 0 ? (
        <p className="text-sm text-on-surface-muted">
          No chats yet. Start one to ask the agent to inspect or change your infrastructure.
        </p>
      ) : (
        <ul className="border border-border rounded-xl divide-y divide-border overflow-hidden">
          {conversations.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between px-4 py-3 hover:bg-surface-overlay transition-colors"
            >
              <button type="button" onClick={() => onOpen(c.id)} className="flex-1 text-left">
                <div className="text-sm font-medium text-on-surface-secondary truncate">
                  {c.title}
                </div>
                <div className="text-xs text-on-surface-faint">
                  {new Date(c.updatedAt).toLocaleString()} · {c.model}
                </div>
              </button>
              <button
                type="button"
                onClick={() => void handleArchive(c.id)}
                className="ml-3 text-xs text-on-surface-faint hover:text-red-500"
              >
                Archive
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
