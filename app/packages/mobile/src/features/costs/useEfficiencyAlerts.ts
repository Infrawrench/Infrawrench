import { useQuery } from "@tanstack/react-query";
import { listEfficiencyAlertEvents } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/** How many recent efficiency-alert firings the mobile section shows. */
const EFFICIENCY_ALERTS_SHOWN = 20;

/**
 * The three efficiency alerts — commitment expiry, idle commitments, unit-cost
 * regression — in one feed (`GET /costs/efficiency-alerts`), newest first.
 *
 * Read-only on mobile, like every other cost surface here: the thresholds are
 * an org-wide policy decision with nine knobs and a phone is not where anyone
 * will set them. What a phone *is* good for is the case these alerts exist
 * for — the push arrives, and the thing it was about is readable here days
 * later when the reader finally has a minute.
 */
export function useEfficiencyAlerts(limit = EFFICIENCY_ALERTS_SHOWN) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["efficiency-alerts", orgId, limit],
    queryFn: () => listEfficiencyAlertEvents(api, orgId, { limit }),
  });
}
