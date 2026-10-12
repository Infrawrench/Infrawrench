import { createFileRoute } from "@tanstack/react-router";

// One framework of the Compliance tab. Like the route above it, the content
// renders in the workspace-tab viewport (which keeps every open tab mounted);
// this route only claims the URL so a framework link is shareable.
export const Route = createFileRoute("/org/$orgId/compliance/$framework")({
  component: () => null,
});
