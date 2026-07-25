/**
 * `sync_version` bumps for the two sync tables that carry no `organization_id`.
 *
 * Every syncable table advances a per-org counter on write, and `/api/v1/sync/pull`
 * returns rows whose counter is greater than the client's watermark. Accounts,
 * resources, and dashboards do this inline with a `MAX(sync_version) + 1`
 * subquery keyed on `organization_id`.
 *
 * `dashboard_pins` and `associations` have no such column — they are scoped
 * through `dashboards` / `resources` — so their subqueries have to join the
 * parent. Nothing was bumping them at all, which left both permanently at the
 * default 0 and therefore invisible to every pull (`0 > lastSyncVersion` is
 * false for any watermark a client can legitimately hold).
 */
import { sql, type SQL } from "drizzle-orm";

/**
 * Next `sync_version` for a dashboard pin in `organizationId`, scoped through
 * the dashboard it hangs off.
 */
export function nextPinSyncVersion(organizationId: string): SQL<number> {
  return sql<number>`COALESCE((
    SELECT MAX(p.sync_version)
    FROM dashboard_pins p
    JOIN dashboards d ON d.id = p.dashboard_id
    WHERE d.organization_id = ${organizationId}
  ), 0) + 1`;
}

/**
 * Next `sync_version` for an association in `organizationId`, scoped through
 * the consumer resource. The consumer is the anchor everywhere else too —
 * `/pull` joins on it, and it is the side the write paths org-check.
 */
export function nextAssociationSyncVersion(organizationId: string): SQL<number> {
  return sql<number>`COALESCE((
    SELECT MAX(a.sync_version)
    FROM associations a
    JOIN resources r ON r.id = a.consumer_resource_id
    WHERE r.organization_id = ${organizationId}
  ), 0) + 1`;
}
