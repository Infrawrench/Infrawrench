/**
 * The org's expiry feed, assembled server-side so the web API, the MCP tool,
 * the weekly digest and the poller's alert pass all read the same computation.
 *
 * Purely a read over already-synced state, exactly like the orphan finder:
 * plugins declare `expiryFields` on their resource types, the shared pure half
 * lives in `@infrawrench/client-core` (`computeExpiryFeed`), and this module
 * only maps Postgres rows onto its input. No plugin clients, no credentials,
 * no provider API calls, ever.
 */
import { and, eq, isNull } from "drizzle-orm";
import {
  computeExpiryFeed,
  expirySeverity,
  mergeExpiryItems,
  type ExpiryItem,
  type ExpiryListResponse,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { accounts, resourceLeases, resources } from "../db/schema";
import { loadPlugins } from "../plugin-loader";
import { getExpirySettings } from "./settings";

export interface ListExpiringOptions {
  /** Scan instant; defaults to `Date.now()`. Fixed in tests. */
  now?: number;
  /**
   * Lead time to compute the `upcoming` bucket against. When omitted the org's
   * stored settings are read (default 60 days when it has no row). Callers
   * that already hold the settings — the poller's alert pass — pass it to
   * avoid a second read.
   */
  leadDays?: number;
}

/**
 * Every declared deadline on the org's stored resources, soonest first.
 * Soft-deleted accounts and resources are excluded, so a deadline can never
 * outlive the thing it belongs to.
 */
const MS_PER_DAY = 86_400_000;

interface LeaseFeedRow {
  resourceId: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  expiresAt: Date;
  autoDelete: boolean;
  note: string | null;
}

/**
 * Active lease rows as kind-`"lease"` expiry items, so leases inherit every
 * surface the radar already has (Expiring tabs, mobile, CLI, digest, the
 * alert pass). Host-injected rather than plugin-declared: the deadline lives
 * on the lease row, not in a synced field. Leases on soft-deleted accounts
 * are excluded (the feed's own stance); the resource name comes from the
 * lease's denormalized copy, so a resource mid-churn still names itself.
 */
function leaseItems(
  rows: LeaseFeedRow[],
  orgAccounts: Array<{ id: string; displayName: string }>,
  plugins: Array<{
    id: string;
    displayName: string;
    resourceTypes: ReadonlyArray<{ id: string; displayName: string }>;
  }>,
  now: number,
  leadDays: number,
): ExpiryItem[] {
  const accountById = new Map(orgAccounts.map((a) => [a.id, a.displayName]));
  const pluginById = new Map(plugins.map((p) => [p.id, p]));
  const items: ExpiryItem[] = [];
  for (const row of rows) {
    const accountName = accountById.get(row.accountId);
    if (accountName === undefined) continue;
    const plugin = pluginById.get(row.pluginId);
    const typeName = plugin?.resourceTypes.find((t) => t.id === row.resourceTypeId)?.displayName;
    const dueMs = row.expiresAt.getTime();
    const daysRemaining = Math.floor((dueMs - now) / MS_PER_DAY);
    items.push({
      resourceId: row.resourceId,
      pluginId: row.pluginId,
      pluginName: plugin?.displayName ?? row.pluginId,
      resourceTypeId: row.resourceTypeId,
      resourceTypeName: typeName ?? row.resourceTypeId,
      accountId: row.accountId,
      accountName,
      displayName: row.displayName,
      externalId: null,
      fieldKey: "lease",
      kind: "lease",
      label: row.note ? `Lease ends — ${row.note}` : "Lease ends",
      basis: "expiry",
      dueAt: new Date(dueMs).toISOString(),
      daysRemaining,
      severity: expirySeverity(daysRemaining, leadDays),
      ...(row.autoDelete ? { leaseAutoDelete: true } : {}),
    });
  }
  return items;
}

export async function listExpiring(
  organizationId: string,
  opts: ListExpiringOptions = {},
): Promise<ExpiryListResponse> {
  const [orgResources, orgAccounts, plugins, leadDays, activeLeases] = await Promise.all([
    db
      .select({
        id: resources.id,
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
        accountId: resources.accountId,
        displayName: resources.displayName,
        externalId: resources.externalId,
        fieldsJson: resources.fieldsJson,
      })
      .from(resources)
      .where(and(eq(resources.organizationId, organizationId), isNull(resources.deletedAt))),
    db
      .select({
        id: accounts.id,
        displayName: accounts.displayName,
        pluginId: accounts.pluginId,
      })
      .from(accounts)
      .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt))),
    loadPlugins(),
    opts.leadDays !== undefined
      ? Promise.resolve(opts.leadDays)
      : getExpirySettings(organizationId).then((s) => s.leadDays),
    db
      .select({
        resourceId: resourceLeases.resourceId,
        pluginId: resourceLeases.pluginId,
        resourceTypeId: resourceLeases.resourceTypeId,
        accountId: resourceLeases.accountId,
        displayName: resourceLeases.displayName,
        expiresAt: resourceLeases.expiresAt,
        autoDelete: resourceLeases.autoDelete,
        note: resourceLeases.note,
      })
      .from(resourceLeases)
      .where(
        and(eq(resourceLeases.organizationId, organizationId), eq(resourceLeases.status, "active")),
      ),
  ]);

  const now = opts.now ?? Date.now();
  const feed = computeExpiryFeed(
    {
      plugins: plugins.map(({ plugin }) => ({
        id: plugin.manifest.id,
        displayName: plugin.manifest.displayName,
        resourceTypes: plugin.resourceTypes,
      })),
      accounts: orgAccounts,
      resources: orgResources.map((r) => ({
        id: r.id,
        pluginId: r.pluginId,
        resourceTypeId: r.resourceTypeId,
        accountId: r.accountId,
        displayName: r.displayName,
        externalId: r.externalId,
        fields: r.fieldsJson,
      })),
    },
    { leadDays, now },
  );

  // Active resource leases ride the same feed as kind "lease" — merged after
  // the scan (their deadline lives on the lease row, not in a synced field)
  // with the evaluator's own sort and counts re-applied, so every consumer of
  // the feed — including `itemsWithinLead` and the counts — sees them.
  return mergeExpiryItems(
    feed,
    leaseItems(
      activeLeases,
      orgAccounts,
      plugins.map(({ plugin }) => ({
        id: plugin.manifest.id,
        displayName: plugin.manifest.displayName,
        resourceTypes: plugin.resourceTypes,
      })),
      now,
      leadDays,
    ),
  );
}
