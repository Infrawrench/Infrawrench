import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/org/$orgId/chat/")({
  // Rendering is handled by WorkspaceTabsViewport in __root.tsx, which mounts
  // every open tab simultaneously and keeps them alive across tab switches —
  // so a streaming conversation survives a switch away and back.
  component: () => null,
});
