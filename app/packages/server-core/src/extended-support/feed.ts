/**
 * The org's extended-support findings at list price, assembled server-side so
 * the web API, the MCP tool, the weekly digest and the poller's alert pass all
 * read the same computation.
 *
 * Purely a read over already-synced rows (`computeExtendedSupport` in
 * `@infrawrench/client-core`). The billed overlay is credentialed and lives
 * in the web app's service (`web/src/services/extended-support.ts`), which
 * starts from this function's output.
 */
import { and, eq, isNull } from "drizzle-orm";
import { computeExtendedSupport, type ExtendedSupportListResponse } from "@infrawrench/client-core";
import { db } from "../db/client";
import { accounts, resources } from "../db/schema";
import { loadPlugins } from "../plugin-loader";
import { getExtendedSupportSettings } from "./settings";

export interface ListExtendedSupportOptions {
  /** Scan instant; defaults to `Date.now()`. */
  now?: number;
  /** Look-ahead override; defaults to the org's setting. */
  leadDays?: number;
}

export async function listExtendedSupport(
  organizationId: string,
  opts: ListExtendedSupportOptions = {},
): Promise<ExtendedSupportListResponse> {
  const [orgResources, orgAccounts, plugins, settings] = await Promise.all([
    db
      .select({
        id: resources.id,
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
        accountId: resources.accountId,
        displayName: resources.displayName,
        externalId: resources.externalId,
        fields: resources.fieldsJson,
      })
      .from(resources)
      .where(and(eq(resources.organizationId, organizationId), isNull(resources.deletedAt))),
    db
      .select({ id: accounts.id, displayName: accounts.displayName, pluginId: accounts.pluginId })
      .from(accounts)
      .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt))),
    loadPlugins(),
    opts.leadDays === undefined ? getExtendedSupportSettings(organizationId) : null,
  ]);

  return computeExtendedSupport(
    {
      plugins: plugins.map(({ plugin }) => ({
        id: plugin.manifest.id,
        displayName: plugin.manifest.displayName,
        resourceTypes: plugin.resourceTypes,
      })),
      accounts: orgAccounts,
      resources: orgResources,
    },
    {
      leadDays: opts.leadDays ?? settings!.leadDays,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    },
  );
}
