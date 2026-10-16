import type { DefaultDashboardResolution } from "@infrawrench/client-core";
import type { DashboardDefaultClient } from "@infrawrench/ui";
import { apiDelete, apiGet, apiPut } from "./api";

/** "My default dashboard" over the org-scoped dashboard routes. */
export function createWebDashboardDefaultClient(orgId: string): DashboardDefaultClient {
  const base = `/api/org/${orgId}/dashboards/default`;
  return {
    getDefault: () => apiGet<DefaultDashboardResolution>(base),
    setMine: (dashboardId) => apiPut<DefaultDashboardResolution>(`${base}/me`, { dashboardId }),
    clearMine: () => apiDelete<DefaultDashboardResolution>(`${base}/me`),
  };
}
