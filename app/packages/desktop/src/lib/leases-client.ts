import {
  useUIStore,
  type LeasesClient,
  type ResourceLease,
  type ResourceLeaseCreate,
  type ResourceLeaseListResponse,
  type ResourceLeasePatch,
} from "@infrawrench/ui";
import { invoke } from "./invoke";

/**
 * Resource lease data access — cloud-mode only (the rows live server-side
 * and the cloud poller runs the auto-delete pass; local mode has no lease
 * store). The org is resolved at call time so signing in or out under a
 * mounted panel reaches the right store, the schedules-client convention.
 */
export function createDesktopLeasesClient(): LeasesClient {
  const requireOrgId = (): string => {
    const orgId = useUIStore.getState().activeCloudOrgId;
    if (!orgId) throw new Error("Resource leases require Infrawrench Cloud — sign in first.");
    return orgId;
  };
  return {
    getResourceLease: async (resourceId: string) => {
      const res = await invoke<{ lease: ResourceLease | null }>("cloud_leases_get_resource", {
        orgId: requireOrgId(),
        resourceId,
      });
      return res.lease;
    },
    listLeases: () =>
      invoke<ResourceLeaseListResponse>("cloud_leases_list", { orgId: requireOrgId() }),
    createLease: (body: ResourceLeaseCreate) =>
      invoke<ResourceLease>("cloud_leases_create", { orgId: requireOrgId(), body }),
    updateLease: (leaseId: string, patch: ResourceLeasePatch) =>
      invoke<ResourceLease>("cloud_leases_update", { orgId: requireOrgId(), leaseId, patch }),
    cancelLease: (leaseId: string) =>
      invoke<ResourceLease>("cloud_leases_cancel", { orgId: requireOrgId(), leaseId }),
    deleteLease: async (leaseId: string) => {
      await invoke("cloud_leases_delete", { orgId: requireOrgId(), leaseId });
    },
  };
}
