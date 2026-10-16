import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/k8s-efficiency")({
  // Rendering is handled by WorkspaceTabsViewport in __root.tsx, which keeps
  // every open tab mounted. `?report=<id>` selects one; the bare path is the list.
  component: () => null,
});
