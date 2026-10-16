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
 * desktop (cloud mode) wraps its cloud-api helpers: the component stays
 * platform-agnostic.
 */
export interface OrphansClient {
  listOrphans(): Promise<OrphanListResponse>;
  /**
   * Tuning for the metric-based idle rules. Optional: a host that cannot
   * reach the cloud (local mode) leaves it off and the section hides the
   * "Idle rules" control.
   */
  idleFindings?: IdleFindingsClient | undefined;
}

export type {
  IdleAccountStatus,
  IdleFindingSettings,
  IdleFindingsOverview,
  IdleRuleView,
} from "@infrawrench/client-core";

import type { IdleFindingSettings, IdleFindingsOverview } from "@infrawrench/client-core";

/**
 * Host-injected access to `/idle-findings`. `save` and `rescan` must reject
 * with the server's message (a 400 bound, a 403) so the modal can show it.
 */
export interface IdleFindingsClient {
  overview(): Promise<IdleFindingsOverview>;
  save(settings: IdleFindingSettings): Promise<IdleFindingSettings>;
  rescan(): Promise<void>;
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
 * the host's resource-update path (the one that enforces change freezes and
 * writes the audit trail) and reject with the server's error message on any
 * refusal so the row can show it verbatim.
 */
export type { ExtendedSupportFinding, ExtendedSupportListResponse } from "@infrawrench/client-core";

import type { ExtendedSupportListResponse } from "@infrawrench/client-core";

/**
 * Host-injected data access for the Extended support section. Web reads the
 * cloud API; desktop picks cloud or the local workspace at call time, the
 * orphans-client stance (the computation is pure, so local mode works too,
 * at list price).
 */
export interface ExtendedSupportClient {
  listExtendedSupport(refresh?: boolean): Promise<ExtendedSupportListResponse>;
}

export interface RightsizingClient {
  listRightsizing(refresh?: boolean): Promise<RightsizingListResponse>;
  applyResize(resource: OversizedResource, accountId: string): Promise<void>;
}

export type {
  SeatFinding,
  SeatListResponse,
  SeatRemovalResponse,
  SeatSettings,
  SeatView,
} from "@infrawrench/client-core";

import type { SeatListResponse, SeatRemovalResponse, SeatSettings } from "@infrawrench/client-core";

/**
 * Host-injected data access for the Seats section. Cloud-only on every host:
 * the inventory is collected by the cloud poller. `removeSeat` must reject
 * with the server's message (a change freeze, a provider refusal) so the row
 * can show it verbatim. `updateSeatSettings` is optional: a host that cannot
 * write the threshold leaves the control out.
 */
export interface SeatsClient {
  listSeats(): Promise<SeatListResponse>;
  refreshSeats(): Promise<{ queued: number }>;
  removeSeat(seatId: string): Promise<SeatRemovalResponse>;
  updateSeatSettings?(settings: SeatSettings): Promise<SeatSettings>;
}
