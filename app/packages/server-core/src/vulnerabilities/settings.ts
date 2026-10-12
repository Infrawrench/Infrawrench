/**
 * Per-org vulnerability alert settings (`org_vulnerability_settings`). A
 * missing row means the shipped defaults: alerts on, critical only, running
 * only. `lastNotifiedAt` is the alert pass's claim and is never written here.
 */
import { eq } from "drizzle-orm";
import {
  DEFAULT_VULNERABILITY_SETTINGS,
  type VulnerabilitySettingsPatch,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { orgVulnerabilitySettings } from "../db/schema";

export interface VulnerabilitySettingsRecord {
  organizationId: string;
  /** `alertsEnabled` on the wire; `enabled` here so the daily-window engine can read it. */
  enabled: boolean;
  minSeverity: "critical" | "high";
  runningOnly: boolean;
  lastNotifiedAt: Date | null;
}

export function defaultVulnerabilitySettings(organizationId: string): VulnerabilitySettingsRecord {
  return {
    organizationId,
    enabled: DEFAULT_VULNERABILITY_SETTINGS.alertsEnabled,
    minSeverity: DEFAULT_VULNERABILITY_SETTINGS.minSeverity,
    runningOnly: DEFAULT_VULNERABILITY_SETTINGS.runningOnly,
    lastNotifiedAt: null,
  };
}

function toRecord(row: typeof orgVulnerabilitySettings.$inferSelect): VulnerabilitySettingsRecord {
  return {
    organizationId: row.organizationId,
    enabled: row.enabled,
    minSeverity: row.minSeverity === "high" ? "high" : "critical",
    runningOnly: row.runningOnly,
    lastNotifiedAt: row.lastNotifiedAt,
  };
}

export async function getVulnerabilitySettings(
  organizationId: string,
): Promise<VulnerabilitySettingsRecord> {
  const [row] = await db
    .select()
    .from(orgVulnerabilitySettings)
    .where(eq(orgVulnerabilitySettings.organizationId, organizationId))
    .limit(1);
  return row ? toRecord(row) : defaultVulnerabilitySettings(organizationId);
}

export type { VulnerabilitySettingsPatch };

export async function updateVulnerabilitySettings(
  organizationId: string,
  patch: VulnerabilitySettingsPatch,
): Promise<VulnerabilitySettingsRecord> {
  const current = await getVulnerabilitySettings(organizationId);
  const next = {
    enabled: patch.alertsEnabled ?? current.enabled,
    minSeverity: patch.minSeverity ?? current.minSeverity,
    runningOnly: patch.runningOnly ?? current.runningOnly,
  };
  const [row] = await db
    .insert(orgVulnerabilitySettings)
    .values({ organizationId, ...next })
    .onConflictDoUpdate({
      target: orgVulnerabilitySettings.organizationId,
      set: { ...next, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("Failed to save vulnerability settings");
  return toRecord(row);
}

/** The wire shape (`VulnerabilitySettings` in client-core). */
export function toVulnerabilitySettingsWire(r: VulnerabilitySettingsRecord) {
  return {
    alertsEnabled: r.enabled,
    minSeverity: r.minSeverity,
    runningOnly: r.runningOnly,
    lastNotifiedAt: r.lastNotifiedAt?.toISOString() ?? null,
  };
}
