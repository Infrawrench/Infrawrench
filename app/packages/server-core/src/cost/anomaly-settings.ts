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
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import {
  COST_ANOMALY_LIMITS,
  COST_ANOMALY_SMS_MODES,
  DEFAULT_COST_ANOMALY_SETTINGS,
  type CostAnomalySettings,
  type CostAnomalySmsMode,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { orgCostAnomalySettings } from "../db/schema";
import type { AnomalyDetectionOptions } from "./anomaly-detect";
import { DEFAULT_ANOMALY_OPTIONS } from "./anomaly-detect";

export type { CostAnomalySettings, CostAnomalySmsMode };
export { COST_ANOMALY_LIMITS, DEFAULT_COST_ANOMALY_SETTINGS };

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * An unknown stored value reads as `off`. This is the one setting that spends
 * money and wakes people, so anything the code does not recognise — a row
 * written by a newer deployment, a hand-edited value — fails closed.
 */
function normalizeSmsMode(value: unknown): CostAnomalySmsMode {
  return COST_ANOMALY_SMS_MODES.includes(value as CostAnomalySmsMode)
    ? (value as CostAnomalySmsMode)
    : "off";
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
    smsAlerts: normalizeSmsMode(input.smsAlerts),
  };
}

/** Whether an anomaly of `kind` is one the org asked to be texted about. */
export function smsWantsKind(mode: CostAnomalySmsMode, kind: "spike" | "new_source"): boolean {
  if (mode === "all") return true;
  if (mode === "new_source") return kind === "new_source";
  return false;
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
    smsAlerts: row.smsAlerts,
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
    smsAlerts: normalizeSmsMode(row.smsAlerts),
  };
}

/** The detector options an org's stored settings imply. */
export async function anomalyOptionsForOrg(
  organizationId: string,
): Promise<AnomalyDetectionOptions> {
  return anomalyOptionsFor(await getOrgAnomalySettings(organizationId));
}

/* ------------------------------------------------------------------ *
 * The SMS rate claim.
 *
 * Anomalies already dedupe per (day, key) and stay quiet for 7 days after
 * notifying, but neither bounds the number of *distinct* keys, and the
 * evaluation pass itself can run once an hour per org. Batching collapses one
 * pass into one text; this column is what stops 24 passes becoming 24 texts.
 * Same protocol as `org_drift_alert_settings.last_notified_at`.
 * ------------------------------------------------------------------ */

/** Least time between two anomaly texts for one org. */
export const ANOMALY_SMS_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** The stored claim's previous value, so a text that reached nobody can undo it. */
export interface AnomalySmsClaim {
  claimed: boolean;
  prior: Date | null;
}

/**
 * Take the org's SMS slot, if the cooldown has elapsed.
 *
 * An UPDATE rather than the upsert drift uses, deliberately: reaching here at
 * all means `sms_alerts <> 'off'`, which only a saved row can say, so there is
 * no missing row to insert — and re-checking the opt-in *inside* the claiming
 * statement is what makes an org that turned the setting off mid-pass silent
 * immediately rather than one text later.
 */
export async function claimAnomalySmsWindow(
  organizationId: string,
  now: Date,
  cooldownMs = ANOMALY_SMS_COOLDOWN_MS,
): Promise<AnomalySmsClaim> {
  const [row] = await db
    .select({ smsLastPagedAt: orgCostAnomalySettings.smsLastPagedAt })
    .from(orgCostAnomalySettings)
    .where(eq(orgCostAnomalySettings.organizationId, organizationId));
  const prior = row?.smsLastPagedAt ?? null;

  const cutoff = new Date(now.getTime() - cooldownMs);
  const claimed = await db
    .update(orgCostAnomalySettings)
    .set({ smsLastPagedAt: now })
    .where(
      and(
        eq(orgCostAnomalySettings.organizationId, organizationId),
        sql`${orgCostAnomalySettings.smsAlerts} <> 'off'`,
        or(
          isNull(orgCostAnomalySettings.smsLastPagedAt),
          lte(orgCostAnomalySettings.smsLastPagedAt, cutoff),
        ),
      ),
    )
    .returning({ organizationId: orgCostAnomalySettings.organizationId });

  return { claimed: claimed.length > 0, prior };
}

/**
 * Give the slot back after a text nobody received, so an outage does not buy
 * six hours of silence. Conditional on still owning the claim — a replica that
 * hung past the cooldown must not rewind a later replica's window.
 */
export async function releaseAnomalySmsWindow(
  organizationId: string,
  claimed: Date,
  prior: Date | null,
): Promise<void> {
  await db
    .update(orgCostAnomalySettings)
    .set({ smsLastPagedAt: prior })
    .where(
      and(
        eq(orgCostAnomalySettings.organizationId, organizationId),
        eq(orgCostAnomalySettings.smsLastPagedAt, claimed),
      ),
    );
}
