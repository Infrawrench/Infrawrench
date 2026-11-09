import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

// Thin wrapper: the section itself is shared with the desktop app's settings
// tab and lives in @infrawrench/ui (see settings/host.tsx for the contract).
// Loaded by module path when the route first renders, so no section ships
// with the app (#912).
export const Route = createFileRoute("/org/$orgId/settings/cost-centres")({
  component: lazyRouteComponent(
    () => import("@infrawrench/ui/settings/CostCentresSection"),
    "CostCentresSection",
  ),
});
