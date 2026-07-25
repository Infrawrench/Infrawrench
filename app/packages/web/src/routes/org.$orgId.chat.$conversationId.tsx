import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/org/$orgId/chat/$conversationId")({
  // Rendered by WorkspaceTabsViewport — see the chat index route.
  component: () => null,
});
