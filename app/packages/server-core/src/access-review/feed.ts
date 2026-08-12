/**
 * The org's cross-cloud access review, assembled server-side so the web API,
 * the CSV export, the weekly digest and the poller's alert pass all read one
 * computation.
 *
 * This is about the principals inside the *customer's* clouds — IAM users and
 * roles, service accounts, app registrations, bindings, long-lived API keys.
 * It is not Infrawrench's own team roles (`permissions/`) and not the
 * credentials Infrawrench itself holds (`hygiene/`).
 *
 * Purely a read over already-synced state, exactly like the orphan finder, the
 * expiry radar and the posture feed: plugins declare `principalRole` on their
 * resource types, the shared pure half lives in `@infrawrench/client-core`
 * (`computeAccessReview`), and this module only maps Postgres rows onto its
 * input. No plugin clients, no credentials, no provider API calls, ever.
 */
import { and, eq, isNull } from "drizzle-orm";
import {
  computeAccessReview,
  normalizeStaleDays,
  type AccessReviewResponse,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { accounts, resources } from "../db/schema";
import { loadPlugins } from "../plugin-loader";
import { listExpiring } from "../expiry/feed";
import { lookupResourceOwners } from "../ownership/store";
import { listPostureDismissals } from "../posture/dismissals";

export interface ListAccessReviewOptions {
  /** Scan instant; defaults to `Date.now()`. Fixed in tests. */
  now?: number;
  /** Staleness window in days; clamped and defaulted by the shared helper. */
  staleDays?: number;
}

/**
 * Every synced principal in the org, with the findings that have evidence
 * against them.
 *
 * Findings the org has dismissed are partitioned into `dismissed` rather than
 * listed — which keeps them out of the alert pass and the digest as well,
 * since both read this one function. The `principals` inventory is never
 * filtered: accepting one finding must not make a principal disappear from the
 * list the review exists to produce.
 *
 * The expiry radar is read alongside rather than reimplemented: it already
 * owns "this credential is past the rotation budget its plugin declares", and
 * a second budget here would drift from the one the Expiring screen shows.
 * A failure there costs the review one rule, not the whole page.
 */
export async function listAccessReview(
  organizationId: string,
  opts: ListAccessReviewOptions = {},
): Promise<AccessReviewResponse> {
  const staleDays = normalizeStaleDays(opts.staleDays);
  const now = opts.now;

  const [orgResources, orgAccounts, plugins, dismissals, expiry] = await Promise.all([
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
    // One dismissal store for both recomputed-finding surfaces; a posture
    // dismissal is simply inert here and vice versa (the rule ids are
    // disjoint, which `plugin-loader.test.ts` enforces).
    listPostureDismissals(organizationId),
    listExpiring(organizationId, now !== undefined ? { now } : {}).catch((err) => {
      console.error(`[access-review] expiry feed for org ${organizationId} failed:`, err);
      return undefined;
    }),
  ]);

  const scanPlugins = plugins.map(({ plugin }) => ({
    id: plugin.manifest.id,
    displayName: plugin.manifest.displayName,
    resourceTypes: plugin.resourceTypes,
  }));
  const scanResources = orgResources.map((r) => ({
    id: r.id,
    pluginId: r.pluginId,
    resourceTypeId: r.resourceTypeId,
    accountId: r.accountId,
    displayName: r.displayName,
    externalId: r.externalId,
    fields: r.fieldsJson,
  }));

  // Ownership is looked up only for the rows that are actually principals —
  // an org with 40 000 resources and 60 keys should not join the whole table
  // to answer "who owns these keys?".
  const principalTypeKeys = new Set<string>();
  for (const plugin of scanPlugins) {
    for (const type of plugin.resourceTypes) {
      if (type.principalRole) principalTypeKeys.add(`${plugin.id}/${type.id}`);
    }
  }
  const principalIds = scanResources
    .filter((r) => principalTypeKeys.has(`${r.pluginId}/${r.resourceTypeId}`))
    .map((r) => r.id);
  const owners = await lookupResourceOwners(organizationId, principalIds);

  return computeAccessReview(
    { plugins: scanPlugins, accounts: orgAccounts, resources: scanResources, owners, dismissals },
    {
      staleDays,
      ...(expiry ? { expiry } : {}),
      ...(now !== undefined ? { now } : {}),
    },
  );
}
