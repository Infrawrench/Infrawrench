import { createFileRoute } from "@tanstack/react-router";

// One canvas: same workspace tab as the list, so this route only claims the URL.
export const Route = createFileRoute("/org/$orgId/cost-canvases/$canvasId")({
  component: () => null,
});
