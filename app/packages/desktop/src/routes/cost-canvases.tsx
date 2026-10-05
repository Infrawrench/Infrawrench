import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/cost-canvases")({
  // Rendering is handled by WorkspaceTabsViewport in __root.tsx, which keeps
  // every open tab mounted. `?canvas=<id>` selects one; the bare path is the list.
  component: () => null,
});
