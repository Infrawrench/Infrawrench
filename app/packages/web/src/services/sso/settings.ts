/**
 * The `org_sso_settings` row, read on every org request by the enforcement
 * gate and so cached briefly per process.
 *
 * The cache is safe to be short-lived and per-replica because of which way it
 * can be wrong. A write on this replica invalidates immediately. A write on
 * another replica is seen within {@link CACHE_TTL_MS}: turning enforcement
 * *on* takes effect up to that late everywhere else (a window the owner chose
 * to open by turning it on moments ago), and turning it *off* or adding a
 * break-glass owner is likewise seen within the TTL, which is the recovery
 * path working, just not instantly.
 */
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { orgSsoSettings } from "../../db/schema";

export type SsoSettingsRow = typeof orgSsoSettings.$inferSelect;

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { row: SsoSettingsRow | null; at: number }>();

export async function loadSsoSettings(organizationId: string): Promise<SsoSettingsRow | null> {
  const [row] = await db
    .select()
    .from(orgSsoSettings)
    .where(eq(orgSsoSettings.organizationId, organizationId))
    .limit(1);
  return row ?? null;
}

/** The settings row through the per-process cache; for the per-request gate only. */
export async function cachedSsoSettings(organizationId: string): Promise<SsoSettingsRow | null> {
  const hit = cache.get(organizationId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.row;
  const row = await loadSsoSettings(organizationId);
  cache.set(organizationId, { row, at: Date.now() });
  if (cache.size > 5000) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return row;
}

export function invalidateSsoSettings(organizationId: string): void {
  cache.delete(organizationId);
}

export async function findSsoSettingsByWorkosOrg(
  workosOrganizationId: string,
): Promise<SsoSettingsRow | null> {
  const [row] = await db
    .select()
    .from(orgSsoSettings)
    .where(eq(orgSsoSettings.workosOrganizationId, workosOrganizationId))
    .limit(1);
  return row ?? null;
}

export async function updateSsoSettings(
  organizationId: string,
  patch: Partial<Omit<SsoSettingsRow, "organizationId" | "workosOrganizationId" | "createdAt">>,
): Promise<SsoSettingsRow | null> {
  const [row] = await db
    .update(orgSsoSettings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(orgSsoSettings.organizationId, organizationId))
    .returning();
  invalidateSsoSettings(organizationId);
  return row ?? null;
}

/** Test seam: forget every cached row. */
export function __resetSsoSettingsCache(): void {
  cache.clear();
}
