/**
 * Per-org tuning for realized savings: the read/write side of
 * `org_savings_settings`.
 *
 * The `cost/efficiency-settings.ts` protocol verbatim: no row means the shipped
 * defaults, validation lives at the API edge (Zod, bounds from
 * `REALIZED_SAVINGS_LIMITS`), and the clamping here is the last line of defence
 * for a row written by hand or by an older client.
 */
import { eq } from "drizzle-orm";
import {
  DEFAULT_REALIZED_SAVINGS_SETTINGS,
  REALIZED_SAVINGS_LIMITS,
  type RealizedSavingsSettings,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { orgSavingsSettings } from "../db/schema";

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** A stored (or hand-written) row forced back inside the documented bounds. */
export function normalizeSavingsSettings(
  input: Partial<RealizedSavingsSettings>,
): RealizedSavingsSettings {
  const d = DEFAULT_REALIZED_SAVINGS_SETTINGS;
  const L = REALIZED_SAVINGS_LIMITS;
  return {
    horizonMonths: clampInt(
      input.horizonMonths,
      L.minHorizonMonths,
      L.maxHorizonMonths,
      d.horizonMonths,
    ),
    shortfallThresholdPercent: clampInt(
      input.shortfallThresholdPercent,
      L.minShortfallThresholdPercent,
      L.maxShortfallThresholdPercent,
      d.shortfallThresholdPercent,
    ),
    baselineWindowDays: clampInt(
      input.baselineWindowDays,
      L.minBaselineWindowDays,
      L.maxBaselineWindowDays,
      d.baselineWindowDays,
    ),
  };
}

export async function getOrgSavingsSettings(
  organizationId: string,
): Promise<RealizedSavingsSettings> {
  const [row] = await db
    .select()
    .from(orgSavingsSettings)
    .where(eq(orgSavingsSettings.organizationId, organizationId))
    .limit(1);
  return row ? normalizeSavingsSettings(row) : { ...DEFAULT_REALIZED_SAVINGS_SETTINGS };
}

export async function setOrgSavingsSettings(
  organizationId: string,
  input: RealizedSavingsSettings,
): Promise<RealizedSavingsSettings> {
  const settings = normalizeSavingsSettings(input);
  await db
    .insert(orgSavingsSettings)
    .values({ organizationId, ...settings, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: orgSavingsSettings.organizationId,
      set: { ...settings, updatedAt: new Date() },
    });
  return settings;
}
