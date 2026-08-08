/**
 * Environment diff, server side: two of the org's accounts compared over rows
 * that are already synced.
 *
 * The comparison itself is the pure `computeEnvironmentDiff` in
 * `@infrawrench/client-core`, which is in turn a second caller of the
 * change-timeline differ. This module only maps Postgres rows onto its input —
 * the same arrangement as the posture feed and the expiry radar. No plugin
 * clients, no credentials, no provider API calls: the answer is as fresh as the
 * last sync and costs two indexed reads.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  computeEnvironmentDiff,
  EnvironmentDiffPluginMismatchError,
  type EnvironmentDiffResponse,
  type EnvironmentDiffSide,
} from "@infrawrench/client-core";
import { db } from "./db/client";
import { accounts, resources } from "./db/schema";
import { loadPlugins } from "./plugin-loader";

export { EnvironmentDiffPluginMismatchError };

/** Neither account exists in this organization (or one was soft-deleted). */
export class EnvironmentDiffAccountNotFoundError extends Error {
  readonly accountId: string;

  constructor(accountId: string) {
    super(`No account ${accountId} in this organization.`);
    this.name = "EnvironmentDiffAccountNotFoundError";
    this.accountId = accountId;
  }
}

export interface EnvironmentDiffOptions {
  /** Compare one resource type only. */
  resourceTypeId?: string | undefined;
  /** Compare the identity/timestamp fields the diff normally filters out. */
  includeIdentityFields?: boolean | undefined;
  /** Clock for `generatedAt`; fixed in tests. */
  now?: number | undefined;
}

/**
 * Compare two accounts' inventories.
 *
 * Throws {@link EnvironmentDiffAccountNotFoundError} for an account outside the
 * organization — the org scope is enforced in the query, so a caller cannot
 * reach across orgs by guessing ids — and
 * {@link EnvironmentDiffPluginMismatchError} when the two use different
 * providers. The route maps both onto 404/400.
 */
export async function loadEnvironmentDiff(
  organizationId: string,
  accountIdA: string,
  accountIdB: string,
  options: EnvironmentDiffOptions = {},
): Promise<EnvironmentDiffResponse> {
  const ids = accountIdA === accountIdB ? [accountIdA] : [accountIdA, accountIdB];
  const rows = await db
    .select({
      id: accounts.id,
      displayName: accounts.displayName,
      pluginId: accounts.pluginId,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, organizationId),
        isNull(accounts.deletedAt),
        inArray(accounts.id, ids),
      ),
    );

  const byId = new Map(rows.map((r) => [r.id, r]));
  const accountA = byId.get(accountIdA);
  const accountB = byId.get(accountIdB);
  if (!accountA) throw new EnvironmentDiffAccountNotFoundError(accountIdA);
  if (!accountB) throw new EnvironmentDiffAccountNotFoundError(accountIdB);

  const [resourceRows, plugins] = await Promise.all([
    db
      .select({
        id: resources.id,
        accountId: resources.accountId,
        resourceTypeId: resources.resourceTypeId,
        displayName: resources.displayName,
        externalId: resources.externalId,
        fieldsJson: resources.fieldsJson,
        outputsJson: resources.outputsJson,
      })
      .from(resources)
      .where(
        and(
          eq(resources.organizationId, organizationId),
          isNull(resources.deletedAt),
          inArray(resources.accountId, ids),
        ),
      ),
    loadPlugins(),
  ]);

  const side = (account: typeof accountA): EnvironmentDiffSide => ({
    accountId: account.id,
    accountName: account.displayName,
    pluginId: account.pluginId,
    resources: resourceRows
      .filter((r) => r.accountId === account.id)
      .map((r) => ({
        id: r.id,
        resourceTypeId: r.resourceTypeId,
        displayName: r.displayName,
        externalId: r.externalId,
        fields: r.fieldsJson,
        outputs: r.outputsJson,
      })),
  });

  // Type names come from the plugin both accounts share; a manifest that no
  // longer declares a type leaves the diff showing the raw id rather than
  // dropping the rows.
  const plugin = plugins.find(({ plugin: p }) => p.manifest.id === accountA.pluginId);
  const resourceTypeNames: Record<string, string> = {};
  for (const type of plugin?.plugin.resourceTypes ?? []) {
    resourceTypeNames[type.id] = type.displayName;
  }

  return computeEnvironmentDiff({
    a: side(accountA),
    b: side(accountB),
    pluginName: plugin?.plugin.manifest.displayName ?? accountA.pluginId,
    resourceTypeNames,
    ...(options.resourceTypeId ? { resourceTypeId: options.resourceTypeId } : {}),
    ...(options.includeIdentityFields ? { includeIdentityFields: true } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}
