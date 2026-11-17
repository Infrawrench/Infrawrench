import { and, eq, isNull } from "drizzle-orm";
import {
  collectOrphanGroups,
  countOrphans,
  countUnownedOrphans,
  primitiveFields,
} from "@infrawrench/plugin-base";
import { getResourceCostTotals } from "../analytics/cost-readers.js";
import { lookupResourceOwners } from "../ownership/store.js";
import { addDays, isoDay } from "../cost/dates.js";
import type {
  OrphanAccountGroup,
  OrphanCostAnnotation,
  OrphanListResponse,
} from "@infrawrench/client-core";
import { db } from "../db/client.js";
import { accounts, resources } from "../db/schema.js";
import { loadPlugins } from "../plugin-loader.js";
import { attachIacHints, type IacHintTarget } from "./remediation-iac.js";
import { idleFeedPlugins, loadStoredIdleFindings, mergeIdleFindings } from "../idle/feed.js";
import { getOrgIdleSettings } from "../idle/settings.js";

/** Days of trailing spend the cost annotation covers. */
const COST_WINDOW_DAYS = 30;

/**
 * Scan an organization's stored resources against each resource type's
 * declarative `orphanRule`, via plugin-base's shared `collectOrphanGroups`:
 * the same scan the desktop app and CLI run over the local SQLite workspace,
 * so a workspace is classified identically wherever it is read. Purely a read
 * over already-synced state: no plugin clients, no credentials, no provider
 * API calls.
 *
 * Cost annotation is what this path adds on top and local mode cannot: trailing
 * spend from ClickHouse grouped by provider-native resource id, matched in
 * memory against `externalId`. Only plugins that emit per-resource cost rows
 * produce matches; everything else gets `cost: null`, and the flag itself never
 * depends on billing data.
 */
export async function listOrphans(
  organizationId: string,
  { includeCosts = true }: { includeCosts?: boolean } = {},
): Promise<OrphanListResponse> {
  const [orgResources, orgAccounts, plugins, idleFindings, idleSettings] = await Promise.all([
    db
      .select({
        id: resources.id,
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
        accountId: resources.accountId,
        displayName: resources.displayName,
        externalId: resources.externalId,
        fieldsJson: resources.fieldsJson,
        lastSyncedAt: resources.lastSyncedAt,
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
    // Metric-based idle verdicts, stored by the poller's idle pass. Best-effort
    // like every annotation here: a failed read costs the idle rows, never
    // the orphan-rule ones.
    loadStoredIdleFindings(organizationId).catch((err: unknown) => {
      console.error("[orphans] idle finding read failed:", err);
      return [];
    }),
    getOrgIdleSettings(organizationId).catch(() => null),
  ]);

  const grouped = collectOrphanGroups({
    plugins: plugins.map(({ plugin }) => ({
      id: plugin.manifest.id,
      displayName: plugin.manifest.displayName,
      resourceTypes: plugin.resourceTypes,
      remediationCommands: plugin.remediationCommands?.bind(plugin),
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
      lastSyncedAt: r.lastSyncedAt ? r.lastSyncedAt.toISOString() : null,
    })),
  });

  if (idleSettings && idleFindings.length > 0) {
    mergeIdleFindings(grouped, {
      findings: idleFindings,
      settings: idleSettings,
      plugins: idleFeedPlugins(plugins),
      accounts: orgAccounts,
      resourcesById: new Map(
        orgResources.map((r) => [
          r.id,
          {
            id: r.id,
            externalId: r.externalId,
            displayName: r.displayName,
            fields: primitiveFields(r.fieldsJson),
            lastSyncedAt: r.lastSyncedAt ? r.lastSyncedAt.toISOString() : null,
          },
        ]),
      ),
    });
  }

  // Spend is protected by `costs:read` separately from the resource list, so
  // callers without it get the flags with `cost: null` rather than a 403.
  if (includeCosts && grouped.length > 0) await annotateCosts(organizationId, grouped);
  // Ownership is not: it rides `resources:read` like the flags themselves,
  // because "whose is this?" is the answer that makes the list actionable and
  // gating it would leave every caller with an anonymous pile of waste.
  if (grouped.length > 0) await annotateOwners(organizationId, grouped);
  // Resources Terraform manages get a "change the code" hint ahead of the CLI
  // commands, so the fix is not reverted by the next apply.
  if (grouped.length > 0) {
    const rowById = new Map(orgResources.map((r) => [r.id, r]));
    const targets: IacHintTarget[] = [];
    for (const group of grouped) {
      for (const r of group.resources) {
        if (!r.remediation) continue;
        // An idle row gets the "remove the block" hint only when removal is
        // the fix (a provisioned table wants a billing-mode edit, not a
        // destroy), and only when it is a synced resource at all.
        if (r.idle && (r.idle.action !== "remove" || !r.idle.hasResource)) continue;
        targets.push({
          resourceId: r.id,
          pluginId: r.pluginId,
          accountId: group.accountId,
          remediation: r.remediation,
          finding: {
            kind: "orphan",
            reason: r.reason,
            ...(r.idle ? { idleRuleId: r.idle.ruleId } : {}),
            resource: {
              resourceTypeId: r.resourceTypeId,
              displayName: r.displayName,
              externalId: r.externalId,
              fields: primitiveFields(rowById.get(r.id)?.fieldsJson),
            },
          },
        });
      }
    }
    await attachIacHints(organizationId, targets);
  }

  // `costBasis` is deliberately not set: absent means "billing", which is what
  // this path always attempts, and leaving it off keeps the HTTP response shape
  // exactly as the OpenAPI schema describes it.
  return {
    accounts: grouped,
    totalCount: countOrphans(grouped),
    unownedCount: countUnownedOrphans(grouped),
    costWindowDays: COST_WINDOW_DAYS,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Attach the owner of each flagged resource, where one is recorded.
 *
 * One batched lookup for the whole scan, not one per row. Best-effort in the
 * same sense as the cost annotation: a failure here costs attribution, never
 * the flags; an unowned-looking list is a worse answer than a slow one, but
 * both are better than no list at all.
 */
async function annotateOwners(organizationId: string, groups: OrphanAccountGroup[]): Promise<void> {
  const ids = groups.flatMap((g) => g.resources.map((r) => r.id));
  let owners: Awaited<ReturnType<typeof lookupResourceOwners>>;
  try {
    owners = await lookupResourceOwners(organizationId, ids);
  } catch (err) {
    console.error("[orphans] owner annotation failed:", err);
    return;
  }
  for (const group of groups) {
    for (const resource of group.resources) {
      resource.owner = owners.get(resource.id) ?? null;
    }
  }
}

/** Attach trailing spend where a provider-native cost row id matches externalId. */
async function annotateCosts(organizationId: string, groups: OrphanAccountGroup[]): Promise<void> {
  const to = isoDay(new Date());
  const from = addDays(to, -(COST_WINDOW_DAYS - 1));
  let totals: Awaited<ReturnType<typeof getResourceCostTotals>>;
  try {
    totals = await getResourceCostTotals(organizationId, from, to);
  } catch {
    return; // ClickHouse down/unconfigured: the finder still works without cost
  }
  if (totals.length === 0) return;

  // A resource id billed in two currencies can't be summed into one number;
  // keep the annotation only when a single currency matched.
  const byKey = new Map<string, OrphanCostAnnotation | "mixed">();
  for (const t of totals) {
    const key = `${t.accountId} ${t.resourceId}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, { amount: t.amount, currency: t.currency });
    } else if (existing !== "mixed" && existing.currency === t.currency) {
      existing.amount += t.amount;
    } else {
      byKey.set(key, "mixed");
    }
  }

  for (const g of groups) {
    for (const r of g.resources) {
      if (!r.externalId) continue;
      const match = byKey.get(`${g.accountId} ${r.externalId}`);
      if (match && match !== "mixed") r.cost = match;
    }
  }
}
