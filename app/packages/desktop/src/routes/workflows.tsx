import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/workflows")({
  // Rendering is handled by WorkspaceTabsViewport in __root.tsx, which mounts
  // every open tab simultaneously and keeps them alive across tab switches.
  component: () => null,
});
