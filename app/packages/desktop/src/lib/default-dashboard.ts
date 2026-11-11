import { getDb } from "../db/client";
import { getCloudDefaultDashboard, listCloudDashboards } from "./cloud-api";

/**
 * The dashboard to fall back to: when signed in, the one the server resolves
 * for this member (their own default, else their role's, else the org's); the
 * local default otherwise. Dashboards live on whichever side is active, so
 * this has to branch on the org rather than always reading the local database.
 */
export async function resolveDefaultDashboard(
  orgId: string | null,
): Promise<{ id: string; name: string } | null> {
  if (orgId) {
    try {
      const resolved = await getCloudDefaultDashboard(orgId);
      if (resolved?.dashboardId) return { id: resolved.dashboardId, name: resolved.dashboardName };
    } catch {
      // An older server without the resolution route: the org default below.
    }
    const list = await listCloudDashboards(orgId);
    const first = list.find((d) => d.isDefault) ?? list[0];
    return first ? { id: first.id, name: first.name } : null;
  }
  const db = await getDb();
  const rows = await db.select<{ id: string; name: string }[]>(
    "SELECT id, name FROM dashboards ORDER BY is_default DESC, name ASC LIMIT 1",
  );
  return rows[0] ?? null;
}
