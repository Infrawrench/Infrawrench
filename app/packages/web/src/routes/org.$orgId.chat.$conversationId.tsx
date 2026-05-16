import { createFileRoute, useParams } from "@tanstack/react-router";
import { ConversationView } from "@/components/chat/ConversationView";

export const Route = createFileRoute("/org/$orgId/chat/$conversationId")({
  component: ChatConversationPage,
});

function ChatConversationPage(): React.ReactElement {
  const { orgId, conversationId } = useParams({
    from: "/org/$orgId/chat/$conversationId",
  });
  return (
    <div className="h-[calc(100vh-0px)] flex flex-col">
      <ConversationView orgId={orgId} conversationId={conversationId} />
    </div>
  );
}
