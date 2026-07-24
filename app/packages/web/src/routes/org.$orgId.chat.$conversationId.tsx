import { createFileRoute, useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import { ConversationView } from "@infrawrench/ui";
import { createWebChatClient } from "@/lib/chat-client";

export const Route = createFileRoute("/org/$orgId/chat/$conversationId")({
  component: ChatConversationPage,
});

function ChatConversationPage(): React.ReactElement {
  const { orgId, conversationId } = useParams({
    from: "/org/$orgId/chat/$conversationId",
  });
  const client = useMemo(() => createWebChatClient(orgId), [orgId]);
  return (
    <div className="h-[calc(100vh-0px)] flex flex-col">
      <ConversationView client={client} conversationId={conversationId} />
    </div>
  );
}
