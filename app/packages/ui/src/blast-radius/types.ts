import type { BlastRadiusReport, DependencyGraphNode } from "@infrawrench/client-core";

export type {
  BlastRadiusDependant,
  BlastRadiusFlowPeer,
  BlastRadiusGap,
  BlastRadiusReference,
  BlastRadiusReferenceKind,
  BlastRadiusReport,
  BlastRadiusSeverity,
} from "@infrawrench/client-core";

/**
 * Host-injected data access for the blast-radius surfaces (the `OwnershipClient`
 * pattern). Web wraps `apiGet`; desktop cloud mode wraps its cloud IPC.
 *
 * One method, because the report is one request by design: assembling it costs
 * an org-wide graph walk, and splitting it into a summary call and a detail
 * call would pay that twice for the same answer.
 */
export interface BlastRadiusClient {
  getBlastRadius(resourceId: string): Promise<BlastRadiusReport>;
}

/** Where a dependant link goes, when the host can navigate to one. */
export type OpenBlastRadiusResource = (node: DependencyGraphNode) => void;
