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
import {
  computeDnsInventory,
  computePostureFindings,
  type PostureListResponse,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { accounts, resources } from "../db/schema";
import { loadPlugins } from "../plugin-loader";
import { listPostureDismissals } from "./dismissals";

export interface ListPostureOptions {
  /** Scan instant; defaults to `Date.now()`. Fixed in tests. */
  now?: number;
}

/**
 * Every matched posture rule on the org's stored resources, worst severity
 * first. Soft-deleted accounts and resources are excluded, so a finding can
 * never outlive the thing it belongs to.
 *
 * Findings the org has dismissed are partitioned into `dismissed` rather than
 * listed — which is what keeps them out of the poller's alert pass, the
 * digest and the MCP tool as well, since all of them read this one function.
 */
export async function listPosture(
  organizationId: string,
  opts: ListPostureOptions = {},
): Promise<PostureListResponse> {
  const [orgResources, orgAccounts, plugins, dismissals] = await Promise.all([
    db
      .select({
        id: resources.id,
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
        accountId: resources.accountId,
        displayName: resources.displayName,
        externalId: resources.externalId,
        // Only the DNS half needs the parent link — it is how a record finds
        // the zone it lives in.
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
    listPostureDismissals(organizationId),
  ]);

  const scanPlugins = plugins.map(({ plugin }) => ({
    id: plugin.manifest.id,
    displayName: plugin.manifest.displayName,
    resourceTypes: plugin.resourceTypes,
  }));
  // parentResourceId is only needed by the DNS half (zone attribution); the
  // declarative posture rules ignore it.
  const scanResources = orgResources.map((r) => ({
    id: r.id,
    pluginId: r.pluginId,
    resourceTypeId: r.resourceTypeId,
    accountId: r.accountId,
    displayName: r.displayName,
    externalId: r.externalId,
    parentResourceId: r.parentResourceId,
    fields: r.fieldsJson,
  }));

  // The one cross-resource check: a record is dangling relative to the whole
  // workspace, so it has to be computed over the same rows and handed in.
  // Recomputed here rather than fetched from `dns/feed` so the two never see
  // different snapshots of the resource table.
  const dns = computeDnsInventory(
    { plugins: scanPlugins, accounts: orgAccounts, resources: scanResources },
    opts.now !== undefined ? { now: opts.now } : {},
  );

  return computePostureFindings(
    {
      plugins: scanPlugins,
      accounts: orgAccounts,
      resources: scanResources,
      dismissals,
    },
    { dns, ...(opts.now !== undefined ? { now: opts.now } : {}) },
  );
}
