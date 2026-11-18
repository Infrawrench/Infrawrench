/**
 * Automatic restore drills: a provider that can make an isolated copy of a
 * database from a restore point (a branch, a fork, a seeded database) lets the
 * host exercise a backup end to end without touching production.
 *
 * The plugin declares `manifest.restoreDrill` and implements three client
 * methods:
 *
 * - {@link PluginClient.startRestoreDrill} asks the provider for a copy of one
 *   resource from a restore point and returns at once with a handle. It must
 *   not wait for the copy to come up: a restore can take minutes and the host
 *   polls instead.
 * - {@link PluginClient.checkRestoreDrill} says whether the copy is ready, and
 *   when it is, how to connect to it with one of the host's SQL drivers.
 * - {@link PluginClient.endRestoreDrill} deletes the copy and everything made
 *   for it. It must succeed when the copy is already gone, because the host
 *   retries it until it does.
 *
 * The host owns the schedule, the clock (restore time, restore point age), the
 * time limit, the verification query, the drill record and the cleanup retries.
 * The plugin owns the provider calls and knows nothing about any of that.
 *
 * A copy must never replace or modify the source: no in-place restore, no
 * promotion, no reset. That is the property that makes running these unattended
 * defensible, and a provider whose only restore is in place does not declare
 * this capability.
 */

/** Where a drill restores from. */
export type RestoreDrillPointKind =
  /** The newest backup the provider lists for the resource. */
  | "latest-backup"
  /** A moment inside the provider's recovery window, chosen as an offset from now. */
  | "point-in-time";

export const RESTORE_DRILL_POINT_KINDS = [
  "latest-backup",
  "point-in-time",
] as const satisfies readonly RestoreDrillPointKind[];

/** One resource type this plugin can drill. */
export interface RestoreDrillTarget {
  /** A resource type id of this plugin; its instances are what gets drilled. */
  resourceTypeId: string;
  /** The restore points the provider can copy from, in the order to offer them. */
  restorePoints: RestoreDrillPointKind[];
  /**
   * The furthest back a point-in-time copy can reach on the most generous plan,
   * in hours. The picker caps its offset here; the provider still refuses a
   * point outside the account's own window, which fails the drill with its
   * message.
   */
  maxLookbackHours?: number;
  /** Typical minutes until a copy can take connections, to suggest a time limit. */
  typicalReadyMinutes?: number;
}

/** What a copy costs while it exists, as the provider publishes it. */
export interface RestoreDrillCost {
  /** One line, e.g. "Billed as branch compute hours while the copy exists." */
  summary: string;
  /** The provider's pricing page. */
  url?: string;
}

/** `manifest.restoreDrill`. */
export interface RestoreDrillDeclaration {
  /** The provider's word for the copy: "branch", "fork", "database". */
  copyNoun: string;
  targets: RestoreDrillTarget[];
  cost?: RestoreDrillCost;
}

export type RestoreDrillPoint =
  | { kind: "latest-backup" }
  /** `at` is an ISO timestamp the host computed from the schedule's offset. */
  | { kind: "point-in-time"; at: string };

export interface RestoreDrillRequest {
  resourceTypeId: string;
  /** Infrawrench id of the resource to copy. */
  resourceId: string;
  accountId: string;
  restorePoint: RestoreDrillPoint;
  /**
   * The name the copy must carry, chosen by the host: short, lowercase letters,
   * digits and dashes, unique per drill, and recognisable as a drill copy in the
   * provider's console.
   */
  copyName: string;
}

/** What {@link PluginClient.startRestoreDrill} returns. */
export interface RestoreDrillHandle {
  /**
   * Opaque to the host, which stores it and passes it back to `check` and `end`.
   * Everything the plugin needs to find the copy again, as a string.
   */
  ref: string;
  /** What was restored, in the provider's terms: a snapshot name, a backup id, a timestamp. */
  restoredFrom: string;
  /** When the data in the copy was current, when the provider says. ISO timestamp. */
  restorePointAt?: string;
}

/** How to reach a ready copy with one of the host's SQL drivers. */
export interface RestoreDrillConnection {
  /** A SQL driver id the host ships: `postgres`, `mysql`, `libsql`, `mysql-planetscale`. */
  driver: string;
  connectionString: string;
  caCert?: string;
}

export type RestoreDrillStatus =
  | { state: "pending"; detail?: string }
  | {
      state: "ready";
      connection: RestoreDrillConnection;
      /** Overrides the handle's value when the provider only knows it once the copy is up. */
      restorePointAt?: string;
    }
  /** The provider gave up on the copy. The host still calls `end`. */
  | { state: "failed"; message: string };

/** Lowercase letters, digits and dashes: every provider here accepts that as a name. */
export function restoreDrillCopyName(runId: string): string {
  return `iw-drill-${runId
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(0, 12)}`;
}
