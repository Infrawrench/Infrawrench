import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/org/$orgId/chat")({
  component: ChatLayout,
});

function ChatLayout(): React.ReactElement {
  return <Outlet />;
}
