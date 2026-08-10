/**
 * Per-org resource-drift alert settings (`org_drift_alert_settings`).
 *
 * Kept apart from `alerts.ts` for the same reason `cost/anomaly-settings.ts` is
 * kept apart from `anomaly-eval.ts`: the settings are an API surface the web
 * app reads and writes, while the evaluator is a poller-side pass. A missing
 * row means the shipped defaults, so an org that never opens the form still has
 * a well-defined filter.
 *
 * Every bound here is enforced server-side rather than in the form, because the
 * numbers are the difference between a digest and a pager storm: a zero
 * cooldown would notify on every sync pass, and that has to be unreachable
 * through the API, not merely un-clickable in the UI.
 */
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { orgDriftAlertSettings } from "../db/schema";
import type { DriftFilter } from "./summary";

/** Bounds the API enforces on the tunable numbers. */
export const DRIFT_ALERT_LIMITS = {
  /**
   * Never below 5 minutes. The poller's cycle is minutes, so a smaller
   * cooldown would put the notification rate back in the hands of the sync
   * rate — the exact coupling the batching exists to break.
   */
  cooldownMinutes: { min: 5, max: 24 * 60 },
  minChanges: { min: 1, max: 1000 },
  /** A scope list longer than this is not a scope; it is every account. */
  maxAccountIds: 200,
} as const;

export interface DriftAlertSettings extends DriftFilter {
  organizationId: string;
  cooldownMinutes: number;
  minChanges: number;
  /** When this org last had a drift digest delivered; null if never. */
  lastNotifiedAt: Date | null;
}

/** What an org that has never touched the form gets. */
export function defaultDriftAlertSettings(organizationId: string): DriftAlertSettings {
  return {
    organizationId,
    notifyCreated: true,
    notifyUpdated: false,
    notifyDeleted: true,
    cooldownMinutes: 60,
    minChanges: 1,
    accountIds: [],
    lastNotifiedAt: null,
  };
}

function toRecord(row: typeof orgDriftAlertSettings.$inferSelect): DriftAlertSettings {
  return {
    organizationId: row.organizationId,
    notifyCreated: row.notifyCreated,
    notifyUpdated: row.notifyUpdated,
    notifyDeleted: row.notifyDeleted,
    cooldownMinutes: row.cooldownMinutes,
    minChanges: row.minChanges,
    accountIds: row.accountIds ?? [],
    lastNotifiedAt: row.lastNotifiedAt,
  };
}

/** The org's settings, or the shipped defaults when it has no row. */
export async function getDriftAlertSettings(organizationId: string): Promise<DriftAlertSettings> {
  const [row] = await db
    .select()
    .from(orgDriftAlertSettings)
    .where(eq(orgDriftAlertSettings.organizationId, organizationId))
    .limit(1);
  return row ? toRecord(row) : defaultDriftAlertSettings(organizationId);
}

export interface DriftAlertSettingsPatch {
  notifyCreated?: boolean;
  notifyUpdated?: boolean;
  notifyDeleted?: boolean;
  cooldownMinutes?: number;
  minChanges?: number;
  accountIds?: string[];
}

function clampInt(value: number, bounds: { min: number; max: number }, label: string): number {
  if (!Number.isInteger(value)) throw new Error(`${label} must be a whole number`);
  if (value < bounds.min || value > bounds.max) {
    throw new Error(`${label} must be between ${bounds.min} and ${bounds.max}`);
  }
  return value;
}

/**
 * Write the org's settings, creating the row on first save. `lastNotifiedAt` is
 * deliberately untouched: it is the cooldown claim `alerts.ts` owns, and
 * resetting it from the settings form would let a save re-open the quiet period
 * mid-window.
 */
export async function updateDriftAlertSettings(
  organizationId: string,
  patch: DriftAlertSettingsPatch,
): Promise<DriftAlertSettings> {
  const current = await getDriftAlertSettings(organizationId);
  const next = {
    notifyCreated: patch.notifyCreated ?? current.notifyCreated,
    notifyUpdated: patch.notifyUpdated ?? current.notifyUpdated,
    notifyDeleted: patch.notifyDeleted ?? current.notifyDeleted,
    cooldownMinutes: clampInt(
      patch.cooldownMinutes ?? current.cooldownMinutes,
      DRIFT_ALERT_LIMITS.cooldownMinutes,
      "cooldownMinutes",
    ),
    minChanges: clampInt(
      patch.minChanges ?? current.minChanges,
      DRIFT_ALERT_LIMITS.minChanges,
      "minChanges",
    ),
    accountIds: patch.accountIds ?? current.accountIds,
  };
  if (next.accountIds.length > DRIFT_ALERT_LIMITS.maxAccountIds) {
    throw new Error(
      `accountIds may name at most ${DRIFT_ALERT_LIMITS.maxAccountIds} accounts; leave it empty for all accounts`,
    );
  }

  const now = new Date();
  const [row] = await db
    .insert(orgDriftAlertSettings)
    .values({ organizationId, ...next })
    .onConflictDoUpdate({
      target: orgDriftAlertSettings.organizationId,
      set: { ...next, updatedAt: now },
    })
    .returning();
  if (!row) throw new Error("Failed to save drift alert settings");
  return toRecord(row);
}
