import { useQuery } from "@tanstack/react-query";
import { listCostAlertEvents, listCostAlerts } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/** How many recent change-alert firings the mobile section shows. */
export const COST_ALERT_EVENTS_SHOWN = 20;

/**
 * The org's change-based cost alerts (`GET /cost-alerts`). Read-only on
 * mobile — creating and editing alerts stays on web/desktop, like anomaly
 * tuning and budget editing.
 */
export function useCostAlerts() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["cost-alerts", orgId],
    queryFn: () => listCostAlerts(api, orgId),
  });
}

/**
 * Recently fired change-alert events (`GET /cost-alerts/events`), newest
 * first. Evaluation runs server-side after each cost collection pass, so
 * this is a plain read; pull-to-refresh on the Costs tab refetches it.
 */
export function useCostAlertEvents(limit = COST_ALERT_EVENTS_SHOWN) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["cost-alert-events", orgId, limit],
    queryFn: () => listCostAlertEvents(api, orgId, { limit }),
  });
}
