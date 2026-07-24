import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import { ChatListView } from "@infrawrench/ui";
import { createWebChatClient } from "@/lib/chat-client";

export const Route = createFileRoute("/org/$orgId/chat/")({
  component: ChatListPage,
});

function ChatListPage(): React.ReactElement {
  const { orgId } = useParams({ from: "/org/$orgId/chat/" });
  const navigate = useNavigate();
  const client = useMemo(() => createWebChatClient(orgId), [orgId]);
  return (
    <ChatListView
      client={client}
      onOpen={(conversationId) =>
        void navigate({
          to: "/org/$orgId/chat/$conversationId",
          params: { orgId, conversationId },
        })
      }
    />
  );
}
