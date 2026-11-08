import { createFileRoute } from "@tanstack/react-router";

// One CI run. Like the list above it, the content renders in the
// workspace-tab viewport; this route only claims the URL so a run link (the
// GitHub check's "Details") is shareable.
export const Route = createFileRoute("/org/$orgId/ci/$runId")({
  component: () => null,
});
