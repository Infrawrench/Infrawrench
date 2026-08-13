/**
 * Per-org posture-check alert settings (`org_posture_settings`).
 *
 * Kept apart from `alerts.ts` for the same reason `expiry/settings.ts` is
 * kept apart from `expiry/alerts.ts`: the settings are an API surface the web
 * app reads and writes, while the alert pass is poller-side. A missing row
 * means the shipped defaults, so an org that never opens the form still has a
 * well-defined stance (alerts on).
 *
 * Unlike the expiry settings there is no lead time — findings have no clock —
 * so the only tunable is the on/off switch.
 */
import { eq } from "drizzle-orm";
import type { PostureSettingsPatch } from "@infrawrench/client-core";
import { db } from "../db/client";
import { orgPostureSettings } from "../db/schema";

export interface PostureSettingsRecord {
  organizationId: string;
  /** Whether the poller sends posture alerts for this org at all. */
  enabled: boolean;
  /**
   * When this org's posture alert scan last completed; null if never. A
   * claim, not bookkeeping — see `alerts.ts`. It records the last *scan*, not
   * necessarily a delivered message: a scan that found nothing alertable
   * keeps it.
   */
  lastNotifiedAt: Date | null;
}

/** What an org that has never touched the form gets. */
export function defaultPostureSettings(organizationId: string): PostureSettingsRecord {
  return { organizationId, enabled: true, lastNotifiedAt: null };
}

function toRecord(row: typeof orgPostureSettings.$inferSelect): PostureSettingsRecord {
  return {
    organizationId: row.organizationId,
    enabled: row.enabled,
    lastNotifiedAt: row.lastNotifiedAt,
  };
}

/** The org's settings, or the shipped defaults when it has no row. */
export async function getPostureSettings(organizationId: string): Promise<PostureSettingsRecord> {
  const [row] = await db
    .select()
    .from(orgPostureSettings)
    .where(eq(orgPostureSettings.organizationId, organizationId))
    .limit(1);
  return row ? toRecord(row) : defaultPostureSettings(organizationId);
}

// The patch shape is the client contract; client-core (`posture.ts`) owns it.
export type { PostureSettingsPatch };

/**
 * Write the org's settings, creating the row on first save. `lastNotifiedAt`
 * is deliberately untouched: it is the cooldown claim `alerts.ts` owns, and
 * resetting it from the settings form would let a save re-open the quiet
 * period mid-window.
 */
export async function updatePostureSettings(
  organizationId: string,
  patch: PostureSettingsPatch,
): Promise<PostureSettingsRecord> {
  const current = await getPostureSettings(organizationId);
  const next = { enabled: patch.enabled ?? current.enabled };

  const now = new Date();
  const [row] = await db
    .insert(orgPostureSettings)
    .values({ organizationId, ...next })
    .onConflictDoUpdate({
      target: orgPostureSettings.organizationId,
      set: { ...next, updatedAt: now },
    })
    .returning();
  if (!row) throw new Error("Failed to save posture alert settings");
  return toRecord(row);
}
