import type { OwnershipClient } from "@infrawrench/ui";
import type {
  OwnerCandidate,
  ResourceOwnership,
  ResourceOwnershipPatch,
} from "@infrawrench/client-core";
import { apiDelete, apiGet, apiPut } from "./api";

/** Web implementation of the ownership surfaces' host-injected data access. */
export function createWebOwnershipClient(orgId: string): OwnershipClient {
  const base = `/api/org/${encodeURIComponent(orgId)}/ownership`;
  return {
    getResourceOwnership: async (resourceId: string) => {
      const res = await apiGet<{ ownership: ResourceOwnership | null }>(
        `${base}/resource?resourceId=${encodeURIComponent(resourceId)}`,
      );
      return res.ownership;
    },
    // The upsert answers `null` when the patch left nothing to record, which
    // is the server deleting the row — the panel renders that as "cleared"
    // rather than inventing an empty record.
    saveResourceOwnership: (patch: ResourceOwnershipPatch) =>
      apiPut<ResourceOwnership | null>(base, patch),
    clearResourceOwnership: async (resourceId: string) => {
      await apiDelete(`${base}?resourceId=${encodeURIComponent(resourceId)}`);
    },
    listMembers: async () =>
      (await apiGet<{ members: OwnerCandidate[] }>(`${base}/members`)).members,
  };
}
