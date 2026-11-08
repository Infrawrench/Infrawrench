import {
  useUIStore,
  type LeasesClient,
  type ResourceLease,
  type ResourceLeaseCreate,
  type ResourceLeaseListResponse,
  type ResourceLeasePatch,
} from "@infrawrench/ui";
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

const leases = () => cloudClient("leases").leases;

/**
 * Resource lease data access: cloud-mode only (the rows live server-side
 * and the cloud poller runs the auto-delete pass; local mode has no lease
 * store). The org is resolved at call time so signing in or out under a
 * mounted panel reaches the right store, the schedules-client convention.
 */
export function createDesktopLeasesClient(): LeasesClient {
  const requireOrgId = (): string => {
    const orgId = useUIStore.getState().activeCloudOrgId;
    if (!orgId) throw new Error("Resource leases require Infrawrench Cloud: sign in first.");
    return orgId;
  };
  return {
    getResourceLease: async (resourceId: string) => {
      const res = await runRpc(
        leases().resource({ params: { orgId: requireOrgId() }, query: { resourceId } }),
      );
      const lease: ResourceLease | null = res.lease;
      return lease;
    },
    listLeases: (): Promise<ResourceLeaseListResponse> =>
      runRpc(leases().list({ params: { orgId: requireOrgId() } })),
    createLease: (body: ResourceLeaseCreate): Promise<ResourceLease> =>
      runRpc(leases().create({ params: { orgId: requireOrgId() }, payload: body })),
    updateLease: (leaseId: string, patch: ResourceLeasePatch): Promise<ResourceLease> =>
      runRpc(leases().update({ params: { orgId: requireOrgId(), leaseId }, payload: patch })),
    cancelLease: (leaseId: string): Promise<ResourceLease> =>
      runRpc(leases().cancel({ params: { orgId: requireOrgId(), leaseId } })),
    deleteLease: async (leaseId: string) => {
      await runRpc(leases().delete({ params: { orgId: requireOrgId(), leaseId } }));
    },
  };
}
