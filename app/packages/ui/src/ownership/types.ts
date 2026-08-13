import type { ResourceOwnership, ResourceOwnershipPatch } from "@infrawrench/client-core";

export type {
  ResourceOwnership,
  ResourceOwnershipListResponse,
  ResourceOwnershipPatch,
} from "@infrawrench/client-core";

/** One person the owner picker can offer. */
export type OwnershipCandidate = import("@infrawrench/client-core").OwnerCandidate;

/**
 * Host-injected data access for the ownership surfaces. Web wraps
 * `apiGet`/`apiPut`; desktop (cloud mode) wraps its cloud IPC — the components
 * stay platform-agnostic (the `LeasesClient` pattern).
 *
 * `listMembers` is part of the client rather than a prop because the owner
 * picker is useless without it, and every host that can store ownership can
 * already list its own team.
 */
export interface OwnershipClient {
  getResourceOwnership(resourceId: string): Promise<ResourceOwnership | null>;
  saveResourceOwnership(patch: ResourceOwnershipPatch): Promise<ResourceOwnership | null>;
  clearResourceOwnership(resourceId: string): Promise<void>;
  /** Org members the owner picker offers. */
  listMembers(): Promise<OwnershipCandidate[]>;
}
