import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/org/$orgId/savings")({
  component: () => null,
});
