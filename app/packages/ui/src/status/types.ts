/**
 * Provider status correlation — host-injected transport contract, same
 * convention as `ChangesClient`: `@infrawrench/ui` owns the markup, each
 * host (web `apiGet`, desktop cloud IPC) injects how to reach
 * `GET /api/org/{orgId}/status-incidents`. Wire types live in
 * `@infrawrench/client-core` so mobile and the CLI agree on them too.
 */
import type { OrgStatusIncidentsResponse } from "@infrawrench/client-core";

export type {
  OrgStatusIncident,
  OrgStatusIncidentsResponse,
  ProviderIncidentImpact,
  ProviderIncidentResourceSample,
  ProviderIncidentState,
} from "@infrawrench/client-core";

export interface StatusIncidentsClient {
  listStatusIncidents(): Promise<OrgStatusIncidentsResponse>;
}
