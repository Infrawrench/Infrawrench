/**
 * The org's DNS inventory, assembled server-side so the web API, the MCP tool
 * and the posture pass all read the same computation.
 *
 * Purely a read over already-synced state, exactly like the orphan finder, the
 * expiry radar and the posture feed: plugins declare `dnsRole` and
 * `dnsServiceHosts` on their resource types, the shared pure half lives in
 * `@infrawrench/client-core` (`computeDnsInventory`), and this module only
 * maps Postgres rows onto its input. No plugin clients, no credentials, no
 * provider API calls — and no DNS resolution.
 */
import { and, eq, isNull } from "drizzle-orm";
import { computeDnsInventory, type DnsInventoryResponse } from "@infrawrench/client-core";
import { db } from "../db/client";
import { accounts, resources } from "../db/schema";
import { loadPlugins } from "../plugin-loader";

export interface ListDnsOptions {
  /** Scan instant; defaults to `Date.now()`. Fixed in tests. */
  now?: number;
}

/**
 * Every declared zone and record on the org's stored resources, with each
 * record target classified against the rest of the workspace. Soft-deleted
 * accounts and resources are excluded, so a zone can never outlive the account
 * it belongs to — and, load-bearing here, a deleted bucket stops claiming the
 * hostname that points at it, which is exactly how a record becomes dangling.
 */
export async function listDns(
  organizationId: string,
  opts: ListDnsOptions = {},
): Promise<DnsInventoryResponse> {
  const [orgResources, orgAccounts, plugins] = await Promise.all([
    db
      .select({
        id: resources.id,
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
        accountId: resources.accountId,
        displayName: resources.displayName,
        externalId: resources.externalId,
        parentResourceId: resources.parentResourceId,
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
  ]);

  return computeDnsInventory(
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
        parentResourceId: r.parentResourceId,
        fields: r.fieldsJson,
      })),
    },
    opts.now !== undefined ? { now: opts.now } : {},
  );
}
