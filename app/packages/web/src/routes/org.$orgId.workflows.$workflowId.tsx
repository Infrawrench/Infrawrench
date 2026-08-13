import { createFileRoute } from "@tanstack/react-router";

// One workflow's editor. Like the list above it, the content renders in the
// workspace-tab viewport (which keeps every open tab mounted); this route only
// claims the URL so a workflow link is shareable — Slack/Teams `infra.page()`
// buttons and the mobile app already address a workflow as
// `/org/{orgId}/workflows/{id}`.
export const Route = createFileRoute("/org/$orgId/workflows/$workflowId")({
  component: () => null,
});
