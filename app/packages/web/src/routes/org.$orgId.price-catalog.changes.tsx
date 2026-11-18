import { createFileRoute } from "@tanstack/react-router";

// The Price catalog tab's Changes view (list-price changes). The content
// renders in the workspace-tab viewport and this route only claims the URL.
export const Route = createFileRoute("/org/$orgId/price-catalog/changes")({
  component: () => null,
});
