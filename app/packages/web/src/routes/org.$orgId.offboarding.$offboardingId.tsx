import { createFileRoute } from "@tanstack/react-router";

// One person's offboarding checklist. Like the list above it, the content
// renders in the workspace-tab viewport; this route only claims the URL so a
// checklist link is shareable.
export const Route = createFileRoute("/org/$orgId/offboarding/$offboardingId")({
  component: () => null,
});
