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
