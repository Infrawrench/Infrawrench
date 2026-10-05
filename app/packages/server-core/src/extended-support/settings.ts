/**
 * Per-org extended-support settings (`org_extended_support_settings`).
 *
 * The `expiry/settings.ts` shape: an API surface the web app reads and writes,
 * kept apart from the poller-side alert pass. A missing row means the shipped
 * defaults. Out-of-range values are rejected rather than clamped, so a form
 * never silently shows a different number from the one the user typed.
 */
import { eq } from "drizzle-orm";
import {
  DEFAULT_EXTENDED_SUPPORT_LEAD_DAYS,
  EXTENDED_SUPPORT_LIMITS,
  type ExtendedSupportSettingsPatch,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { orgExtendedSupportSettings } from "../db/schema";

export interface ExtendedSupportSettingsRecord {
  organizationId: string;
  enabled: boolean;
  leadDays: number;
  /** The alert pass's cooldown claim; see `alerts.ts`. */
  lastNotifiedAt: Date | null;
}

export function defaultExtendedSupportSettings(
  organizationId: string,
): ExtendedSupportSettingsRecord {
  return {
    organizationId,
    enabled: true,
    leadDays: DEFAULT_EXTENDED_SUPPORT_LEAD_DAYS,
    lastNotifiedAt: null,
  };
}

function toRecord(
  row: typeof orgExtendedSupportSettings.$inferSelect,
): ExtendedSupportSettingsRecord {
  return {
    organizationId: row.organizationId,
    enabled: row.enabled,
    leadDays: row.leadDays,
    lastNotifiedAt: row.lastNotifiedAt,
  };
}

/** The org's settings, or the shipped defaults when it has no row. */
export async function getExtendedSupportSettings(
  organizationId: string,
): Promise<ExtendedSupportSettingsRecord> {
  const [row] = await db
    .select()
    .from(orgExtendedSupportSettings)
    .where(eq(orgExtendedSupportSettings.organizationId, organizationId))
    .limit(1);
  return row ? toRecord(row) : defaultExtendedSupportSettings(organizationId);
}

export type { ExtendedSupportSettingsPatch };

/** Thrown for a patch the API rejects; routes map it to a 400. */
export class ExtendedSupportSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtendedSupportSettingsError";
  }
}

function checkLeadDays(value: number): number {
  const { min, max } = EXTENDED_SUPPORT_LIMITS.leadDays;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ExtendedSupportSettingsError(`leadDays must be a whole number from ${min} to ${max}`);
  }
  return value;
}

/**
 * Write the org's settings, creating the row on first save. `lastNotifiedAt`
 * is left alone: it is the alert pass's claim, and a save must not reopen a
 * window mid-cooldown.
 */
export async function updateExtendedSupportSettings(
  organizationId: string,
  patch: ExtendedSupportSettingsPatch,
): Promise<ExtendedSupportSettingsRecord> {
  const current = await getExtendedSupportSettings(organizationId);
  const next = {
    enabled: patch.enabled ?? current.enabled,
    leadDays: checkLeadDays(patch.leadDays ?? current.leadDays),
  };
  const [row] = await db
    .insert(orgExtendedSupportSettings)
    .values({ organizationId, ...next })
    .onConflictDoUpdate({
      target: orgExtendedSupportSettings.organizationId,
      set: { ...next, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("Failed to save extended support settings");
  return toRecord(row);
}
