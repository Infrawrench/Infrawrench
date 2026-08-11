/**
 * Per-org quota-radar alert settings (`org_quota_settings`).
 *
 * Kept apart from `alerts.ts` for the same reason `expiry/settings.ts` is kept
 * apart from `expiry/alerts.ts`: the settings are an API surface the web app
 * reads and writes, while the alert pass is poller-side. A missing row means
 * the shipped defaults, so an org that never opens the form still has a
 * well-defined threshold.
 *
 * The bound is enforced server-side rather than only in the form because the
 * threshold drives both the feed's severity buckets and what the poller alerts
 * on: a threshold near zero makes every quota "critical", which is the same as
 * having no radar, and a threshold of exactly 1.0 only fires once the provider
 * is already refusing requests.
 */
import { eq } from "drizzle-orm";
import { DEFAULT_QUOTA_THRESHOLD, QUOTA_ALERT_LIMITS } from "@infrawrench/client-core";
import { db } from "../db/client";
import { orgQuotaSettings } from "../db/schema";

export { QUOTA_ALERT_LIMITS };

export interface QuotaSettingsRecord {
  organizationId: string;
  /** Whether the poller sends quota alerts for this org at all. */
  enabled: boolean;
  /** Utilisation fraction (0–1) at or above which a quota alerts. */
  threshold: number;
  /**
   * When this org's quota alert scan last completed; null if never. A claim,
   * not bookkeeping — see `alerts.ts`. It records the last *scan*, not
   * necessarily a delivered message: a scan that found nothing keeps it.
   */
  lastNotifiedAt: Date | null;
}

/** What an org that has never touched the form gets. */
export function defaultQuotaSettings(organizationId: string): QuotaSettingsRecord {
  return {
    organizationId,
    enabled: true,
    threshold: DEFAULT_QUOTA_THRESHOLD,
    lastNotifiedAt: null,
  };
}

function toRecord(row: typeof orgQuotaSettings.$inferSelect): QuotaSettingsRecord {
  return {
    organizationId: row.organizationId,
    enabled: row.enabled,
    threshold: row.threshold,
    lastNotifiedAt: row.lastNotifiedAt,
  };
}

/** The org's settings, or the shipped defaults when it has no row. */
export async function getQuotaSettings(organizationId: string): Promise<QuotaSettingsRecord> {
  const [row] = await db
    .select()
    .from(orgQuotaSettings)
    .where(eq(orgQuotaSettings.organizationId, organizationId))
    .limit(1);
  return row ? toRecord(row) : defaultQuotaSettings(organizationId);
}

export interface QuotaSettingsPatchInput {
  enabled?: boolean;
  threshold?: number;
}

/**
 * Reject rather than clamp.
 *
 * Clamping a threshold silently turns "alert me at 40%" into "alert me at 50%"
 * and the form then shows a number the user did not type — which reads as the
 * setting not having saved. The expiry settings take the same stance for
 * `leadDays`.
 */
function checkThreshold(value: number): number {
  if (!Number.isFinite(value)) throw new Error("threshold must be a number");
  const { min, max } = QUOTA_ALERT_LIMITS.threshold;
  if (value < min || value > max) {
    throw new Error(
      `threshold must be between ${min} and ${max} (a fraction of the limit, so 0.8 is 80%)`,
    );
  }
  return value;
}

/**
 * Write the org's settings, creating the row on first save. `lastNotifiedAt`
 * is deliberately untouched: it is the cooldown claim `alerts.ts` owns, and
 * resetting it from the settings form would let a save re-open the quiet
 * period mid-window.
 */
export async function updateQuotaSettings(
  organizationId: string,
  patch: QuotaSettingsPatchInput,
  updatedByUserId?: string,
): Promise<QuotaSettingsRecord> {
  const current = await getQuotaSettings(organizationId);
  const next = {
    enabled: patch.enabled ?? current.enabled,
    threshold: checkThreshold(patch.threshold ?? current.threshold),
  };

  const now = new Date();
  const [row] = await db
    .insert(orgQuotaSettings)
    .values({
      organizationId,
      ...next,
      ...(updatedByUserId ? { updatedByUserId } : {}),
    })
    .onConflictDoUpdate({
      target: orgQuotaSettings.organizationId,
      set: {
        ...next,
        updatedAt: now,
        ...(updatedByUserId ? { updatedByUserId } : {}),
      },
    })
    .returning();
  if (!row) throw new Error("Failed to save quota alert settings");
  return toRecord(row);
}
