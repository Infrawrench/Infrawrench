import type {
  ResourceLease,
  ResourceLeaseCreate,
  ResourceLeaseListResponse,
  ResourceLeasePatch,
} from "@infrawrench/client-core";

export type {
  LeaseStatus,
  ResourceLease,
  ResourceLeaseCreate,
  ResourceLeaseListResponse,
  ResourceLeasePatch,
} from "@infrawrench/client-core";

/**
 * Host-injected data access for the resource lease surfaces. Web wraps
 * `apiGet`/`apiPost`; desktop (cloud mode) wraps its cloud IPC — the
 * components stay platform-agnostic (the `SchedulesClient` pattern).
 */
export interface LeasesClient {
  getResourceLease(resourceId: string): Promise<ResourceLease | null>;
  listLeases(): Promise<ResourceLeaseListResponse>;
  createLease(body: ResourceLeaseCreate): Promise<ResourceLease>;
  updateLease(leaseId: string, patch: ResourceLeasePatch): Promise<ResourceLease>;
  cancelLease(leaseId: string): Promise<ResourceLease>;
  deleteLease(leaseId: string): Promise<void>;
}
