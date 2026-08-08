/**
 * Resource ownership — cloud-mode only. One wrapper per allowlisted IPC
 * channel, matching `cloud-probes.ts`.
 */
import type {
  OwnerCandidate,
  ResourceOwnership,
  ResourceOwnershipPatch,
} from "@infrawrench/client-core";
import { invoke } from "./invoke";

export async function listCloudOwnerCandidates(orgId: string): Promise<OwnerCandidate[]> {
  const res = await invoke<{ members: OwnerCandidate[] }>("cloud_ownership_members", { orgId });
  return res.members;
}

export async function fetchCloudResourceOwnership(
  orgId: string,
  resourceId: string,
): Promise<ResourceOwnership | null> {
  const res = await invoke<{ ownership: ResourceOwnership | null }>("cloud_ownership_get", {
    orgId,
    resourceId,
  });
  return res.ownership;
}

/** Answers null when the patch left nothing to record — the row is dropped. */
export async function saveCloudResourceOwnership(
  orgId: string,
  patch: ResourceOwnershipPatch,
): Promise<ResourceOwnership | null> {
  return invoke("cloud_ownership_save", { orgId, patch });
}

export async function clearCloudResourceOwnership(
  orgId: string,
  resourceId: string,
): Promise<void> {
  await invoke("cloud_ownership_clear", { orgId, resourceId });
}
