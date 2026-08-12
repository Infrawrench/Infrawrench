import { createFileRoute } from "@tanstack/react-router";

// One incident's detail. Like the list above it, the content renders in the
// workspace-tab viewport (which keeps every open tab mounted); this route only
// claims the URL so an incident link is shareable.
export const Route = createFileRoute("/org/$orgId/incidents/$incidentId")({
  component: () => null,
});
