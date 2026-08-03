import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useUIStore } from "@infrawrench/ui";
import { MetricAlertsPanel } from "@infrawrench/ui/metric-alerts";
import { createDesktopMetricAlertsClient } from "@/lib/metric-alerts-client";

export const Route = createFileRoute("/metric-alerts")({
  component: MetricAlertsPage,
});

/**
 * Metric threshold alert rules on desktop — the same screen web renders.
 * A plain route rather than a workspace tab, matching Changes/Expiring.
 * Cloud-only: rules are evaluated by the cloud poller, so the sidebar tile
 * only shows with an active cloud org.
 */
function MetricAlertsPage() {
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const client = useMemo(() => createDesktopMetricAlertsClient(), []);

  if (!activeCloudOrgId) {
    return (
      <div className="p-6 text-sm text-on-surface-faint">
        Metric alerts require cloud mode — sign in to sync.
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Keyed by org so switching org remounts and refetches. */}
      <MetricAlertsPanel key={activeCloudOrgId} client={client} />
    </div>
  );
}
