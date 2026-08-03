import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { MetricAlertsPanel } from "@infrawrench/ui/metric-alerts";
import { createWebMetricAlertsClient } from "@/lib/metric-alerts-client";

export const Route = createFileRoute("/org/$orgId/metric-alerts")({
  component: MetricAlertsPage,
});

/**
 * Metric threshold alert rules. The panel lives in `@infrawrench/ui` so
 * desktop renders the identical screen; this route is the web host. A plain
 * route rather than a workspace tab, matching Changes/Expiring — the list has
 * no per-instance state worth keeping mounted.
 */
function MetricAlertsPage() {
  const { orgId } = Route.useParams();
  const client = useMemo(() => createWebMetricAlertsClient(orgId), [orgId]);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Keyed by org so switching org remounts and refetches. */}
      <MetricAlertsPanel key={orgId} client={client} />
    </div>
  );
}
