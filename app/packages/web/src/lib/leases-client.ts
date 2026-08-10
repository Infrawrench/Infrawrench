import type {
  LeasesClient,
  ResourceLease,
  ResourceLeaseCreate,
  ResourceLeaseListResponse,
  ResourceLeasePatch,
} from "@infrawrench/ui";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";

/** Web implementation of the resource-lease surfaces' host-injected data access. */
export function createWebLeasesClient(orgId: string): LeasesClient {
  const base = `/api/org/${orgId}/leases`;
  return {
    getResourceLease: async (resourceId: string) => {
      const res = await apiGet<{ lease: ResourceLease | null }>(
        `${base}/resource?resourceId=${encodeURIComponent(resourceId)}`,
      );
      return res.lease;
    },
    listLeases: () => apiGet<ResourceLeaseListResponse>(base),
    createLease: (body: ResourceLeaseCreate) => apiPost<ResourceLease>(base, body),
    updateLease: (leaseId: string, patch: ResourceLeasePatch) =>
      apiPut<ResourceLease>(`${base}/${encodeURIComponent(leaseId)}`, patch),
    cancelLease: (leaseId: string) =>
      apiPost<ResourceLease>(`${base}/${encodeURIComponent(leaseId)}/cancel`, {}),
    deleteLease: async (leaseId: string) => {
      await apiDelete(`${base}/${encodeURIComponent(leaseId)}`);
    },
  };
}
