import { useNavigate } from "@tanstack/react-router";
import { ChatListView, ConversationView, type ChatClient } from "@infrawrench/ui";
import { createWebChatClient } from "@/lib/chat-client";
import { chatTabTarget, navigateToWorkspaceTarget } from "@/lib/workspace-tabs";

// Stable client per org so the shared chat components' effects don't refire
// each render (same pattern as the workflow/agent clients).
const chatClients = new Map<string, ChatClient>();
function getWebChatClient(orgId: string): ChatClient {
  let client = chatClients.get(orgId);
  if (!client) {
    client = createWebChatClient(orgId);
    chatClients.set(orgId, client);
  }
  return client;
}

interface Props {
  orgId: string;
  conversationId?: string | undefined;
}

/**
 * Org-level AI chat rendered as a workspace tab — the web counterpart of the
 * desktop CloudChatPanel. ConversationView keeps the tab's title in sync with
 * the conversation (they auto-rename after the first message).
 */
export function WebChatPanel({ orgId, conversationId }: Props) {
  const navigate = useNavigate();
  const client = getWebChatClient(orgId);

  if (conversationId) {
    return (
      <div className="h-full flex flex-col">
        <ConversationView client={client} conversationId={conversationId} />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <ChatListView
        client={client}
        onOpen={(id) => void navigateToWorkspaceTarget(navigate, chatTabTarget(id))}
      />
    </div>
  );
}
