/**
 * Per-organization feature flags: which organizations a platform admin has
 * let into a feature that is still being rolled out (`ORG_FEATURES`).
 */
import { and, eq, inArray } from "drizzle-orm";
import { isOrgFeature, type OrgFeature } from "@infrawrench/client-core";

import { db } from "./db/client.js";
import { organizationFeatures } from "./db/schema.js";

/** The features an organization has, sorted. */
export async function orgFeatures(organizationId: string): Promise<OrgFeature[]> {
  const rows = await db
    .select({ feature: organizationFeatures.feature })
    .from(organizationFeatures)
    .where(eq(organizationFeatures.organizationId, organizationId));
  return rows
    .map((r) => r.feature)
    .filter(isOrgFeature)
    .sort();
}

export async function orgHasFeature(organizationId: string, feature: OrgFeature): Promise<boolean> {
  const [row] = await db
    .select({ feature: organizationFeatures.feature })
    .from(organizationFeatures)
    .where(
      and(
        eq(organizationFeatures.organizationId, organizationId),
        eq(organizationFeatures.feature, feature),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Every organization's features, for the admin list. */
export async function featuresByOrg(organizationIds: string[]): Promise<Map<string, OrgFeature[]>> {
  const out = new Map<string, OrgFeature[]>();
  if (organizationIds.length === 0) return out;
  const rows = await db
    .select({
      organizationId: organizationFeatures.organizationId,
      feature: organizationFeatures.feature,
    })
    .from(organizationFeatures)
    .where(inArray(organizationFeatures.organizationId, organizationIds));
  for (const r of rows) {
    if (!isOrgFeature(r.feature)) continue;
    out.set(r.organizationId, [...(out.get(r.organizationId) ?? []), r.feature].sort());
  }
  return out;
}

/** Turns a feature on or off for an organization. Idempotent. */
export async function setOrgFeature(
  organizationId: string,
  feature: OrgFeature,
  enabled: boolean,
  by: string,
): Promise<void> {
  if (enabled) {
    await db
      .insert(organizationFeatures)
      .values({ organizationId, feature, enabledBy: by })
      .onConflictDoNothing();
  } else {
    await db
      .delete(organizationFeatures)
      .where(
        and(
          eq(organizationFeatures.organizationId, organizationId),
          eq(organizationFeatures.feature, feature),
        ),
      );
  }
}
