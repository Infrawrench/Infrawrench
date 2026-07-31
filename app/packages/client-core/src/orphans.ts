/**
 * Orphan & idle resource finder — the wire contract for
 * `GET /api/org/:orgId/orphans`, shared by the web app, the desktop app's
 * savings panel, and the `infrawrench orphans` CLI subcommand.
 *
 * Classification itself lives in plugin-base (`orphanRule` on resource types,
 * evaluated by `evaluateOrphanRule`); these types only describe how the host
 * aggregates the matches per organization.
 */

/** Best-effort spend attributed to one flagged resource. */
export interface OrphanCostAnnotation {
  /** Spend over the trailing cost window, in `currency`. */
  amount: number;
  /** ISO 4217 code, e.g. "USD". */
  currency: string;
}

export interface OrphanedResource {
  /** Infrawrench resource id. */
  id: string;
  pluginId: string;
  resourceTypeId: string;
  /** Display name of the resource type, e.g. "EBS Volume". */
  resourceTypeName: string;
  displayName: string;
  /** Provider-native id, when known. */
  externalId: string | null;
  /** Plugin-authored explanation, e.g. "Volume is not attached to any Droplet". */
  reason: string;
  /**
   * Trailing spend matched against the org's collected cost rows, or null
   * when no per-resource cost rows exist for it (most providers). The flag
   * itself never depends on cost data.
   */
  cost: OrphanCostAnnotation | null;
  /** Last time this resource's state was synced from the provider, if ever. */
  lastSyncedAt: string | null;
}

export interface OrphanAccountGroup {
  accountId: string;
  accountName: string;
  pluginId: string;
  /** Plugin display name, e.g. "DigitalOcean". */
  pluginName: string;
  resources: OrphanedResource[];
}

export interface OrphanListResponse {
  /** Groups sorted by account name; empty when nothing is flagged. */
  accounts: OrphanAccountGroup[];
  /** Total flagged resources across all groups. */
  totalCount: number;
  /** Days of trailing spend the cost annotations cover. */
  costWindowDays: number;
  generatedAt: string;
}
