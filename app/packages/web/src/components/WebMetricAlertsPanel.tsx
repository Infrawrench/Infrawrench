import { useMemo } from "react";
import { MetricAlertsPanel } from "@infrawrench/ui/metric-alerts";
import { createWebMetricAlertsClient } from "@/lib/metric-alerts-client";

/**
 * Metric threshold alert rules. The panel lives in `@infrawrench/ui` so
 * desktop renders the identical screen; this component is the web host.
 * Rendered as a workspace tab (the "metric-alerts" kind) by
 * WebWorkspaceTabsViewport.
 */
export function WebMetricAlertsPanel({ orgId }: { orgId: string }) {
  const client = useMemo(() => createWebMetricAlertsClient(orgId), [orgId]);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Keyed by org so switching org remounts and refetches. */}
      <MetricAlertsPanel key={orgId} client={client} />
    </div>
  );
}
