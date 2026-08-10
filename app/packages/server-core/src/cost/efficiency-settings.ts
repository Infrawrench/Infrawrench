/**
 * Per-org tuning for the three efficiency detectors — commitment expiry, idle
 * commitments, unit-cost regression. The read/write side of
 * `org_cost_efficiency_settings`, plus the clamping that keeps a hand-written
 * row from producing a detector that misbehaves.
 *
 * `cost/anomaly-settings.ts`' protocol, deliberately verbatim: a missing row
 * means the shipped defaults, so an org that has never opened the form is
 * indistinguishable from one that saved them and the feature works for every
 * org that predates the table. Validation lives at the API edge
 * (`COST_EFFICIENCY_LIMITS`, enforced by the Zod schema in
 * `@infrawrench/ui/cost/config`); the clamping here is the last line of
 * defence for a row written by hand or by an older client.
 */
import { eq } from "drizzle-orm";
import {
  COST_EFFICIENCY_LIMITS,
  DEFAULT_COST_EFFICIENCY_SETTINGS,
  type CostEfficiencySettings,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { orgCostEfficiencySettings } from "../db/schema";

export type { CostEfficiencySettings };
export { COST_EFFICIENCY_LIMITS, DEFAULT_COST_EFFICIENCY_SETTINGS };

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Horizons forced back inside the documented bounds: integers, positive,
 * de-duplicated, descending, and capped in count.
 *
 * An empty list after filtering falls back to the defaults rather than to
 * "never warn". A row that stores `[]` is far more likely to be a form that
 * cleared itself than a considered request for silence, and silence is what
 * `commitmentExpiryEnabled: false` is for — a knob that says so out loud.
 */
export function normalizeExpiryHorizons(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : [];
  const cleaned = [
    ...new Set(
      raw
        .map((h) => Number(h))
        .filter((h) => Number.isFinite(h))
        .map((h) => Math.round(h))
        .filter(
          (h) =>
            h >= COST_EFFICIENCY_LIMITS.minExpiryHorizonDays &&
            h <= COST_EFFICIENCY_LIMITS.maxExpiryHorizonDays,
        ),
    ),
  ]
    .sort((a, b) => b - a)
    .slice(0, COST_EFFICIENCY_LIMITS.maxExpiryHorizons);
  return cleaned.length > 0
    ? cleaned
    : [...DEFAULT_COST_EFFICIENCY_SETTINGS.commitmentExpiryHorizonDays];
}

/** A stored row (or a hand-written one) forced back inside the documented bounds. */
export function normalizeEfficiencySettings(
  input: Partial<CostEfficiencySettings>,
): CostEfficiencySettings {
  const d = DEFAULT_COST_EFFICIENCY_SETTINGS;
  const L = COST_EFFICIENCY_LIMITS;
  return {
    commitmentExpiryEnabled: bool(input.commitmentExpiryEnabled, d.commitmentExpiryEnabled),
    commitmentExpiryHorizonDays: normalizeExpiryHorizons(input.commitmentExpiryHorizonDays),
    commitmentExpiryAlertOnExpired: bool(
      input.commitmentExpiryAlertOnExpired,
      d.commitmentExpiryAlertOnExpired,
    ),

    commitmentIdleEnabled: bool(input.commitmentIdleEnabled, d.commitmentIdleEnabled),
    commitmentIdleThresholdPercent: clampInt(
      input.commitmentIdleThresholdPercent,
      L.minIdleThresholdPercent,
      L.maxIdleThresholdPercent,
      d.commitmentIdleThresholdPercent,
    ),
    commitmentIdleWindowDays: clampInt(
      input.commitmentIdleWindowDays,
      L.minIdleWindowDays,
      L.maxIdleWindowDays,
      d.commitmentIdleWindowDays,
    ),
    commitmentIdleMinMeasuredDays: clampInt(
      input.commitmentIdleMinMeasuredDays,
      L.minIdleMinMeasuredDays,
      L.maxIdleMinMeasuredDays,
      d.commitmentIdleMinMeasuredDays,
    ),
    commitmentIdleMinWasteCents: clampInt(
      input.commitmentIdleMinWasteCents,
      L.minIdleWasteCents,
      L.maxIdleWasteCents,
      d.commitmentIdleMinWasteCents,
    ),

    unitCostRegressionEnabled: bool(input.unitCostRegressionEnabled, d.unitCostRegressionEnabled),
    unitCostThresholdPercent: clampInt(
      input.unitCostThresholdPercent,
      L.minUnitCostThresholdPercent,
      L.maxUnitCostThresholdPercent,
      d.unitCostThresholdPercent,
    ),
    unitCostWindowDays: clampInt(
      input.unitCostWindowDays,
      L.minUnitCostWindowDays,
      L.maxUnitCostWindowDays,
      d.unitCostWindowDays,
    ),
    unitCostMinReportedDays: clampInt(
      input.unitCostMinReportedDays,
      L.minUnitCostReportedDays,
      L.maxUnitCostReportedDays,
      d.unitCostMinReportedDays,
    ),
    unitCostMinSpendCents: clampInt(
      input.unitCostMinSpendCents,
      L.minUnitCostSpendCents,
      L.maxUnitCostSpendCents,
      d.unitCostMinSpendCents,
    ),
  };
}

/**
 * A reported days requirement can exceed the window it is measured in — a
 * clamp on each field independently cannot see the other. Both detectors
 * would then be permanently silent, which is the failure mode a bound is
 * supposed to prevent, so the pair is reconciled here: the requirement gives
 * way to the window rather than the other way round, because shrinking the
 * window is the deliberate act and the requirement is a floor on confidence.
 */
export function reconcileWindowRequirements(
  settings: CostEfficiencySettings,
): CostEfficiencySettings {
  return {
    ...settings,
    commitmentIdleMinMeasuredDays: Math.min(
      settings.commitmentIdleMinMeasuredDays,
      settings.commitmentIdleWindowDays,
    ),
    unitCostMinReportedDays: Math.min(
      settings.unitCostMinReportedDays,
      settings.unitCostWindowDays,
    ),
  };
}

/** The org's efficiency tuning; a missing row reads as the shipped defaults. */
export async function getOrgEfficiencySettings(
  organizationId: string,
): Promise<CostEfficiencySettings> {
  const [row] = await db
    .select()
    .from(orgCostEfficiencySettings)
    .where(eq(orgCostEfficiencySettings.organizationId, organizationId));
  if (!row) return reconcileWindowRequirements({ ...DEFAULT_COST_EFFICIENCY_SETTINGS });
  return reconcileWindowRequirements(
    normalizeEfficiencySettings({
      commitmentExpiryEnabled: row.commitmentExpiryEnabled,
      commitmentExpiryHorizonDays: row.commitmentExpiryHorizonDays,
      commitmentExpiryAlertOnExpired: row.commitmentExpiryAlertOnExpired,
      commitmentIdleEnabled: row.commitmentIdleEnabled,
      commitmentIdleThresholdPercent: row.commitmentIdleThresholdPercent,
      commitmentIdleWindowDays: row.commitmentIdleWindowDays,
      commitmentIdleMinMeasuredDays: row.commitmentIdleMinMeasuredDays,
      commitmentIdleMinWasteCents: row.commitmentIdleMinWasteCents,
      unitCostRegressionEnabled: row.unitCostRegressionEnabled,
      unitCostThresholdPercent: row.unitCostThresholdPercent,
      unitCostWindowDays: row.unitCostWindowDays,
      unitCostMinReportedDays: row.unitCostMinReportedDays,
      unitCostMinSpendCents: row.unitCostMinSpendCents,
    }),
  );
}

/** Save the org's efficiency tuning, creating the row on first use. */
export async function setOrgEfficiencySettings(
  organizationId: string,
  settings: CostEfficiencySettings,
  now = new Date(),
): Promise<CostEfficiencySettings> {
  const safe = normalizeEfficiencySettings(settings);
  const [row] = await db
    .insert(orgCostEfficiencySettings)
    .values({ organizationId, ...safe })
    .onConflictDoUpdate({
      target: orgCostEfficiencySettings.organizationId,
      set: { ...safe, updatedAt: now },
    })
    .returning();
  if (!row) throw new Error("Failed to save cost efficiency settings");
  // Returned un-reconciled: the form should show what was stored, so a user
  // who set a 7-day window with a 10-day requirement sees their own numbers
  // and can fix them, rather than watching one silently change under them.
  return safe;
}
