import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/invoices")({
  // Rendering is handled by WorkspaceTabsViewport in __root.tsx, which mounts
  // every open tab simultaneously and keeps them alive across tab switches.
  // `?invoice=<id>` selects one; the list is the bare path.
  component: () => null,
});
