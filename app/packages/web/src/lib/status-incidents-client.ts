import type { OrgStatusIncidentsResponse, StatusIncidentsClient } from "@infrawrench/ui";
import { apiGet } from "./api";

/** Web binding for the provider status correlation surfaces — thin `apiGet`. */
export function createWebStatusIncidentsClient(orgId: string): StatusIncidentsClient {
  return {
    listStatusIncidents: () =>
      apiGet<OrgStatusIncidentsResponse>(`/api/org/${orgId}/status-incidents`),
  };
}
