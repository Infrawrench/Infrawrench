import { useMemo } from "react";
import { useUIStore } from "@infrawrench/ui";
import { MetricAlertsPanel } from "@infrawrench/ui/metric-alerts";
import { createDesktopMetricAlertsClient } from "@/lib/metric-alerts-client";

/**
 * Metric threshold alert rules on desktop — the same screen web renders.
 * Rendered as a workspace tab (the "metric-alerts" kind). Cloud-only: rules
 * are evaluated by the cloud poller, so without an org the tab explains
 * rather than fetching.
 */
export function DesktopMetricAlertsPanel() {
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
