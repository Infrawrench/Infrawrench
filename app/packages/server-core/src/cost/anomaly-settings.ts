/**
 * Per-org tuning for cost anomaly detection: the read/write side of the
 * `org_cost_anomaly_settings` table, plus the translation from the stored
 * record (USD cents, what the API and the UI speak) into the
 * `AnomalyDetectionOptions` the pure detector takes (currency units).
 *
 * A missing row means the shipped defaults, exactly the way
 * `org_digest_settings` treats a missing row as disabled — an org that has
 * never opened the form is indistinguishable from one that saved the defaults,
 * so the feature keeps working for every org that predates the table.
 *
 * Validation lives at the API edge (`COST_ANOMALY_LIMITS`, enforced by the Zod
 * schema in `@infrawrench/ui/cost/config`); this module clamps as a last line
 * of defence so a row written by hand, or by an older client, still produces a
 * detector that behaves.
 */
import { eq } from "drizzle-orm";
import {
  COST_ANOMALY_LIMITS,
  DEFAULT_COST_ANOMALY_SETTINGS,
  type CostAnomalySettings,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { orgCostAnomalySettings } from "../db/schema";
import type { AnomalyDetectionOptions } from "./anomaly-detect";
import { DEFAULT_ANOMALY_OPTIONS } from "./anomaly-detect";

export type { CostAnomalySettings };
export { COST_ANOMALY_LIMITS, DEFAULT_COST_ANOMALY_SETTINGS };

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** A stored row (or a hand-written one) forced back inside the documented bounds. */
export function normalizeAnomalySettings(input: CostAnomalySettings): CostAnomalySettings {
  return {
    sigmas: clamp(
      input.sigmas,
      COST_ANOMALY_LIMITS.sigmasMin,
      COST_ANOMALY_LIMITS.sigmasMax,
      DEFAULT_COST_ANOMALY_SETTINGS.sigmas,
    ),
    minDeltaCents: Math.round(
      clamp(
        input.minDeltaCents,
        COST_ANOMALY_LIMITS.minDeltaCentsMin,
        COST_ANOMALY_LIMITS.minDeltaCentsMax,
        DEFAULT_COST_ANOMALY_SETTINGS.minDeltaCents,
      ),
    ),
    newSourceMinCents: Math.round(
      clamp(
        input.newSourceMinCents,
        COST_ANOMALY_LIMITS.newSourceMinCentsMin,
        COST_ANOMALY_LIMITS.newSourceMinCentsMax,
        DEFAULT_COST_ANOMALY_SETTINGS.newSourceMinCents,
      ),
    ),
  };
}

/**
 * Turn a settings record into detector options. Cents become currency units;
 * `minBaselineDays` is not a user knob — it is a statement about how much
 * history a baseline needs before it means anything — so it comes from the
 * shipped defaults.
 */
export function anomalyOptionsFor(settings: CostAnomalySettings): AnomalyDetectionOptions {
  const safe = normalizeAnomalySettings(settings);
  return {
    sigmas: safe.sigmas,
    minDeltaAbs: safe.minDeltaCents / 100,
    minBaselineDays: DEFAULT_ANOMALY_OPTIONS.minBaselineDays,
    minNewSourceAbs: safe.newSourceMinCents / 100,
  };
}

/** The org's anomaly tuning; a missing row reads as the shipped defaults. */
export async function getOrgAnomalySettings(organizationId: string): Promise<CostAnomalySettings> {
  const [row] = await db
    .select()
    .from(orgCostAnomalySettings)
    .where(eq(orgCostAnomalySettings.organizationId, organizationId));
  if (!row) return { ...DEFAULT_COST_ANOMALY_SETTINGS };
  return normalizeAnomalySettings({
    sigmas: row.sigmas,
    minDeltaCents: row.minDeltaCents,
    newSourceMinCents: row.newSourceMinCents,
  });
}

/** Save the org's anomaly tuning, creating the row on first use. */
export async function setOrgAnomalySettings(
  organizationId: string,
  settings: CostAnomalySettings,
  now = new Date(),
): Promise<CostAnomalySettings> {
  const safe = normalizeAnomalySettings(settings);
  const [row] = await db
    .insert(orgCostAnomalySettings)
    .values({ organizationId, ...safe })
    .onConflictDoUpdate({
      target: orgCostAnomalySettings.organizationId,
      set: { ...safe, updatedAt: now },
    })
    .returning();
  if (!row) throw new Error("Failed to save cost anomaly settings");
  return {
    sigmas: row.sigmas,
    minDeltaCents: row.minDeltaCents,
    newSourceMinCents: row.newSourceMinCents,
  };
}

/** The detector options an org's stored settings imply. */
export async function anomalyOptionsForOrg(
  organizationId: string,
): Promise<AnomalyDetectionOptions> {
  return anomalyOptionsFor(await getOrgAnomalySettings(organizationId));
}
