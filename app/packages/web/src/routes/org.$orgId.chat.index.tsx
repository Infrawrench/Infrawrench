import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { CHAT_CONVERSATIONS_CHANGED_EVENT } from "@/lib/chat-events";
import type { ConversationSummary } from "@/components/chat/types";

export const Route = createFileRoute("/org/$orgId/chat/")({
  component: ChatListPage,
});

function ChatListPage(): React.ReactElement {
  const { orgId } = useParams({ from: "/org/$orgId/chat/" });
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);

  async function load(): Promise<void> {
    const res = await apiGet<{ conversations: ConversationSummary[] }>(
      `/api/org/${orgId}/chat/conversations`,
    );
    setConversations(res.conversations);
  }

  useEffect(() => {
    void load();
  }, [orgId]);

  async function handleNew(): Promise<void> {
    const res = await apiPost<{ id: string }>(`/api/org/${orgId}/chat/conversations`, {});
    window.dispatchEvent(new Event(CHAT_CONVERSATIONS_CHANGED_EVENT));
    await navigate({
      to: "/org/$orgId/chat/$conversationId",
      params: { orgId, conversationId: res.id },
    });
  }

  async function handleArchive(id: string): Promise<void> {
    await apiDelete(`/api/org/${orgId}/chat/conversations/${id}`);
    window.dispatchEvent(new Event(CHAT_CONVERSATIONS_CHANGED_EVENT));
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
              <button
                type="button"
                onClick={() =>
                  void navigate({
                    to: "/org/$orgId/chat/$conversationId",
                    params: { orgId, conversationId: c.id },
                  })
                }
                className="flex-1 text-left"
              >
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
