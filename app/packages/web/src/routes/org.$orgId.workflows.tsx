import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/org/$orgId/workflows")({
  // Rendering is handled by WorkspaceTabsViewport in __root.tsx, which mounts
  // every open tab simultaneously and keeps them alive across tab switches.
  // The route still matches for URL navigation; the matching tab's panel is
  // what actually renders.
  component: () => null,
});
