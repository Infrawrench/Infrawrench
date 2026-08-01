/**
 * Per-org expiry-radar alert settings (`org_expiry_settings`).
 *
 * Kept apart from `alerts.ts` for the same reason `drift/settings.ts` is kept
 * apart from `drift/alerts.ts`: the settings are an API surface the web app
 * reads and writes, while the alert pass is poller-side. A missing row means
 * the shipped defaults, so an org that never opens the form still has a
 * well-defined lead time.
 *
 * The bounds are enforced server-side rather than in the form because the lead
 * time drives both the feed's `upcoming` bucket and what the poller alerts on:
 * a zero or negative lead would silence the radar, and a multi-year one would
 * page about every certificate an org owns.
 */
import { eq } from "drizzle-orm";
import { DEFAULT_EXPIRY_LEAD_DAYS } from "@infrawrench/client-core";
import { db } from "../db/client";
import { orgExpirySettings } from "../db/schema";

/** Bounds the API enforces on the tunable numbers. */
export const EXPIRY_ALERT_LIMITS = {
  leadDays: { min: 1, max: 365 },
} as const;

export interface ExpirySettingsRecord {
  organizationId: string;
  /** Whether the poller sends expiry alerts for this org at all. */
  enabled: boolean;
  /** Days of lead time before a deadline counts as `upcoming` and alertable. */
  leadDays: number;
  /**
   * When this org's expiry alert scan last completed; null if never. A claim,
   * not bookkeeping — see `alerts.ts`. It records the last *scan*, not
   * necessarily a delivered message: a scan that found nothing due keeps it.
   */
  lastNotifiedAt: Date | null;
}

/** What an org that has never touched the form gets. */
export function defaultExpirySettings(organizationId: string): ExpirySettingsRecord {
  return {
    organizationId,
    enabled: true,
    leadDays: DEFAULT_EXPIRY_LEAD_DAYS,
    lastNotifiedAt: null,
  };
}

function toRecord(row: typeof orgExpirySettings.$inferSelect): ExpirySettingsRecord {
  return {
    organizationId: row.organizationId,
    enabled: row.enabled,
    leadDays: row.leadDays,
    lastNotifiedAt: row.lastNotifiedAt,
  };
}

/** The org's settings, or the shipped defaults when it has no row. */
export async function getExpirySettings(organizationId: string): Promise<ExpirySettingsRecord> {
  const [row] = await db
    .select()
    .from(orgExpirySettings)
    .where(eq(orgExpirySettings.organizationId, organizationId))
    .limit(1);
  return row ? toRecord(row) : defaultExpirySettings(organizationId);
}

export interface ExpirySettingsPatch {
  enabled?: boolean;
  leadDays?: number;
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
export async function updateExpirySettings(
  organizationId: string,
  patch: ExpirySettingsPatch,
): Promise<ExpirySettingsRecord> {
  const current = await getExpirySettings(organizationId);
  const next = {
    enabled: patch.enabled ?? current.enabled,
    leadDays: clampInt(
      patch.leadDays ?? current.leadDays,
      EXPIRY_ALERT_LIMITS.leadDays,
      "leadDays",
    ),
  };

  const now = new Date();
  const [row] = await db
    .insert(orgExpirySettings)
    .values({ organizationId, ...next })
    .onConflictDoUpdate({
      target: orgExpirySettings.organizationId,
      set: { ...next, updatedAt: now },
    })
    .returning();
  if (!row) throw new Error("Failed to save expiry alert settings");
  return toRecord(row);
}
