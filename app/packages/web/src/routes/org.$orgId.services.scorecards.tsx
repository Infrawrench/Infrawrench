import { createFileRoute } from "@tanstack/react-router";

// The Services tab's scorecards view (the matrix and scorecard management).
// A static segment, so it outranks `$serviceId`; the content renders in the
// workspace-tab viewport and this route only claims the URL.
export const Route = createFileRoute("/org/$orgId/services/scorecards")({
  component: () => null,
});
