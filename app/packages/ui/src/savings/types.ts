import type { OrphanListResponse } from "@infrawrench/client-core";

/**
 * The orphan-finder contract lives in client-core so mobile (which doesn't
 * depend on this package) shares one definition; re-exported for web and
 * desktop.
 */
export type {
  OrphanListResponse,
  OrphanAccountGroup,
  OrphanedResource,
  OrphanCostAnnotation,
  OrphanCostBasis,
} from "@infrawrench/client-core";

/**
 * Host-injected data access for the Potential savings section. Web wraps `apiGet`;
 * desktop (cloud mode) wraps its cloud-api helpers — the component stays
 * platform-agnostic.
 */
export interface OrphansClient {
  listOrphans(): Promise<OrphanListResponse>;
}

export type {
  OversizedAccountGroup,
  OversizedResource,
  OversizedSizeSummary,
  RightsizingListResponse,
} from "@infrawrench/client-core";

import type { OversizedResource, RightsizingListResponse } from "@infrawrench/client-core";

/**
 * Host-injected data access for the Oversized section. `applyResize` must
 * submit `{ [resource.sizeFieldKey]: resource.recommendedSize.id }` through
 * the host's resource-update path — the one that enforces change freezes and
 * writes the audit trail — and reject with the server's error message on any
 * refusal so the row can show it verbatim.
 */
export interface RightsizingClient {
  listRightsizing(refresh?: boolean): Promise<RightsizingListResponse>;
  applyResize(resource: OversizedResource, accountId: string): Promise<void>;
}
