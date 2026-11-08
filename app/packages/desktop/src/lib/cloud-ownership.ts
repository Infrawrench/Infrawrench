/**
 * Resource ownership: cloud-mode only. Typed calls to the contract's
 * `ownership` domain over the cloud transport (`./cloud-client.ts`),
 * matching `cloud-probes.ts`.
 */
import type {
  OwnerCandidate,
  ResourceOwnership,
  ResourceOwnershipPatch,
} from "@infrawrench/client-core";
import { Effect } from "effect";
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

const ownership = () => cloudClient("ownership").ownership;

export function listCloudOwnerCandidates(orgId: string): Promise<OwnerCandidate[]> {
  return runRpc(
    ownership()
      .members({ params: { orgId } })
      .pipe(Effect.map((res) => res.members)),
  );
}

export function fetchCloudResourceOwnership(
  orgId: string,
  resourceId: string,
): Promise<ResourceOwnership | null> {
  return runRpc(
    ownership()
      .resource({ params: { orgId }, query: { resourceId } })
      .pipe(Effect.map((res) => res.ownership)),
  );
}

/** Answers null when the patch left nothing to record: the row is dropped. */
export function saveCloudResourceOwnership(
  orgId: string,
  patch: ResourceOwnershipPatch,
): Promise<ResourceOwnership | null> {
  return runRpc(ownership().set({ params: { orgId }, payload: patch }));
}

export function clearCloudResourceOwnership(orgId: string, resourceId: string): Promise<void> {
  return runRpc(ownership().clear({ params: { orgId }, query: { resourceId } }));
}
