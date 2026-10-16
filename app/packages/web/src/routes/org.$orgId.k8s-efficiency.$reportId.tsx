import { createFileRoute } from "@tanstack/react-router";

// One report: same workspace tab as the list, so this route only claims the URL.
export const Route = createFileRoute("/org/$orgId/k8s-efficiency/$reportId")({
  component: () => null,
});
