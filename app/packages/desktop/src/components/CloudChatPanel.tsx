import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChatListView, ConversationView, useUIStore, type ChatClient } from "@infrawrench/ui";
import { createDesktopChatClient } from "@/lib/cloud-chat";
import { chatTabTarget, navigateToWorkspaceTarget } from "@/lib/workspace-tabs";

// Stable client per org so the shared chat components' effects don't refire
// each render (same pattern as the workflow/agent clients).
const chatClients = new Map<string, ChatClient>();
export function getDesktopChatClient(orgId: string): ChatClient {
  let client = chatClients.get(orgId);
  if (!client) {
    client = createDesktopChatClient(orgId);
    chatClients.set(orgId, client);
  }
  return client;
}

interface Props {
  conversationId?: string | undefined;
}

/**
 * Org-level AI chat, proxied through the cloud web API. Only available when
 * the desktop is signed in to Infrawrench Cloud with an active org — in
 * local-only mode there is no server-side agent to talk to.
 */
export function CloudChatPanel({ conversationId }: Props) {
  const navigate = useNavigate();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const client = useMemo(
    () => (activeCloudOrgId ? getDesktopChatClient(activeCloudOrgId) : null),
    [activeCloudOrgId],
  );

  if (!client) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <p className="text-sm text-on-surface-muted max-w-sm text-center">
          Chat runs through Infrawrench Cloud. Sign in and select an organization to ask the agent
          about your infrastructure.
        </p>
      </div>
    );
  }

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
