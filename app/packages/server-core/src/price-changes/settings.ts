/**
 * Per-org price-change watch settings (`org_price_change_settings`), the
 * `extended-support/settings.ts` shape: a missing row means the shipped
 * defaults, out-of-range values are rejected rather than clamped, and saving
 * never touches `lastNotifiedAt` (the daily scan's claim).
 */
import { eq } from "drizzle-orm";
import {
  PRICE_CHANGE_DEFAULTS,
  priceChangeSettingsError,
  type PriceChangeSettingsPatch,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { orgPriceChangeSettings } from "../db/schema";

export interface PriceChangeSettingsRecord {
  organizationId: string;
  enabled: boolean;
  minMonthlyImpactCents: number;
  minPercent: number;
  registerExpected: boolean;
  lastNotifiedAt: Date | null;
}

export function defaultPriceChangeSettings(organizationId: string): PriceChangeSettingsRecord {
  return {
    organizationId,
    enabled: PRICE_CHANGE_DEFAULTS.enabled,
    minMonthlyImpactCents: PRICE_CHANGE_DEFAULTS.minMonthlyImpactCents,
    minPercent: PRICE_CHANGE_DEFAULTS.minPercent,
    registerExpected: PRICE_CHANGE_DEFAULTS.registerExpected,
    lastNotifiedAt: null,
  };
}

function toRecord(row: typeof orgPriceChangeSettings.$inferSelect): PriceChangeSettingsRecord {
  return {
    organizationId: row.organizationId,
    enabled: row.enabled,
    minMonthlyImpactCents: row.minMonthlyImpactCents,
    minPercent: row.minPercent,
    registerExpected: row.registerExpected,
    lastNotifiedAt: row.lastNotifiedAt,
  };
}

/** The org's settings, or the shipped defaults when it has no row. */
export async function getPriceChangeSettings(
  organizationId: string,
): Promise<PriceChangeSettingsRecord> {
  const [row] = await db
    .select()
    .from(orgPriceChangeSettings)
    .where(eq(orgPriceChangeSettings.organizationId, organizationId))
    .limit(1);
  return row ? toRecord(row) : defaultPriceChangeSettings(organizationId);
}

export type { PriceChangeSettingsPatch };

/** Thrown for a patch the API rejects; routes map it to a 400. */
export class PriceChangeSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceChangeSettingsError";
  }
}

/** Write the org's settings, creating the row on first save. */
export async function updatePriceChangeSettings(
  organizationId: string,
  patch: PriceChangeSettingsPatch,
): Promise<PriceChangeSettingsRecord> {
  const problem = priceChangeSettingsError(patch);
  if (problem) throw new PriceChangeSettingsError(problem);
  const current = await getPriceChangeSettings(organizationId);
  const next = {
    enabled: patch.enabled ?? current.enabled,
    minMonthlyImpactCents: patch.minMonthlyImpactCents ?? current.minMonthlyImpactCents,
    minPercent: patch.minPercent ?? current.minPercent,
    registerExpected: patch.registerExpected ?? current.registerExpected,
  };
  const [row] = await db
    .insert(orgPriceChangeSettings)
    .values({ organizationId, ...next })
    .onConflictDoUpdate({
      target: orgPriceChangeSettings.organizationId,
      set: { ...next, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("Failed to save price change settings");
  return toRecord(row);
}
