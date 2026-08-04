/**
 * The org's posture findings, assembled server-side so the web API, the MCP
 * tool, the weekly digest and the poller's alert pass all read the same
 * computation.
 *
 * Purely a read over already-synced state, exactly like the orphan finder and
 * the expiry radar: plugins declare `postureChecks` on their resource types,
 * the shared pure half lives in `@infrawrench/client-core`
 * (`computePostureFindings`), and this module only maps Postgres rows onto
 * its input. No plugin clients, no credentials, no provider API calls, ever.
 */
import { and, eq, isNull } from "drizzle-orm";
import { computePostureFindings, type PostureListResponse } from "@infrawrench/client-core";
import { db } from "../db/client";
import { accounts, resources } from "../db/schema";
import { loadPlugins } from "../plugin-loader";

export interface ListPostureOptions {
  /** Scan instant; defaults to `Date.now()`. Fixed in tests. */
  now?: number;
}

/**
 * Every matched posture rule on the org's stored resources, worst severity
 * first. Soft-deleted accounts and resources are excluded, so a finding can
 * never outlive the thing it belongs to.
 */
export async function listPosture(
  organizationId: string,
  opts: ListPostureOptions = {},
): Promise<PostureListResponse> {
  const [orgResources, orgAccounts, plugins] = await Promise.all([
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
  ]);

  return computePostureFindings(
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
    opts.now !== undefined ? { now: opts.now } : {},
  );
}
