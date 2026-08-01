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
import { computeExpiryFeed, type ExpiryListResponse } from "@infrawrench/client-core";
import { db } from "../db/client";
import { accounts, resources } from "../db/schema";
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
export async function listExpiring(
  organizationId: string,
  opts: ListExpiringOptions = {},
): Promise<ExpiryListResponse> {
  const [orgResources, orgAccounts, plugins, leadDays] = await Promise.all([
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
  ]);

  return computeExpiryFeed(
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
    { leadDays, ...(opts.now !== undefined ? { now: opts.now } : {}) },
  );
}
