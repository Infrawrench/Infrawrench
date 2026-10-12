/**
 * The org's DORA settings singleton (`org_dora_settings`). A missing row is
 * the shipped defaults, so an org that never opens the form still gets
 * well-defined metrics. Bounds are enforced here, not in the form: the API and
 * the Terraform provider write through the same check.
 */
import { eq } from "drizzle-orm";
import {
  DORA_SETTINGS_DEFAULTS,
  normalizeDoraPatterns,
  validateDoraSettings,
  type DoraSettings,
  type DoraSettingsView,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { orgDoraSettings } from "../db/schema";

export class DoraSettingsError extends Error {
  readonly status = 400 as const;
}

function toView(row: typeof orgDoraSettings.$inferSelect): DoraSettingsView {
  return {
    failureWindowHours: row.failureWindowHours,
    productionEnvironments: row.productionEnvironments,
    pipelinePatterns: row.pipelinePatterns,
    countFailedDeploys: row.countFailedDeploys,
    includeResourceChanges: row.includeResourceChanges,
    digestEnabled: row.digestEnabled,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getDoraSettings(organizationId: string): Promise<DoraSettingsView> {
  const [row] = await db
    .select()
    .from(orgDoraSettings)
    .where(eq(orgDoraSettings.organizationId, organizationId))
    .limit(1);
  return row ? toView(row) : { ...DORA_SETTINGS_DEFAULTS, updatedAt: null };
}

/** Merge a patch over the stored settings, validate, and write the row. */
export async function updateDoraSettings(
  organizationId: string,
  patch: Partial<DoraSettings>,
  userId: string | null,
): Promise<DoraSettingsView> {
  const problem = validateDoraSettings(patch);
  if (problem) throw new DoraSettingsError(problem);
  const current = await getDoraSettings(organizationId);
  const next: DoraSettings = {
    failureWindowHours: patch.failureWindowHours ?? current.failureWindowHours,
    productionEnvironments: normalizeDoraPatterns(
      patch.productionEnvironments ?? current.productionEnvironments,
    ),
    pipelinePatterns: normalizeDoraPatterns(patch.pipelinePatterns ?? current.pipelinePatterns),
    countFailedDeploys: patch.countFailedDeploys ?? current.countFailedDeploys,
    includeResourceChanges: patch.includeResourceChanges ?? current.includeResourceChanges,
    digestEnabled: patch.digestEnabled ?? current.digestEnabled,
  };
  // Normalizing can empty a list that validated (all blanks); check again.
  const after = validateDoraSettings(next);
  if (after) throw new DoraSettingsError(after);
  const now = new Date();
  const [row] = await db
    .insert(orgDoraSettings)
    .values({ organizationId, ...next, updatedByUserId: userId, updatedAt: now })
    .onConflictDoUpdate({
      target: orgDoraSettings.organizationId,
      set: { ...next, updatedByUserId: userId, updatedAt: now },
    })
    .returning();
  if (!row) throw new Error("Failed to save DORA settings");
  return toView(row);
}
