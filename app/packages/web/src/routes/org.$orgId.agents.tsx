import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/org/$orgId/agents")({
  component: () => null,
});
