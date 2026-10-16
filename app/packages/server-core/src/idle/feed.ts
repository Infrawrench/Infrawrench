/**
 * Read side of the metric-based idle findings.
 *
 * Two readers over the stored verdicts (`account_idle_findings`):
 *
 * - {@link idleOrphanRows} turns them into `OrphanedResource` rows that
 *   `listOrphans` merges into the orphan feed, so every savings surface shows
 *   them without learning a second shape. The org's settings are applied at
 *   read time too, so switching a rule off hides its rows immediately rather
 *   than at the next collection.
 * - {@link getIdleFindingsOverview} is the tuning panel's data: the settings,
 *   the declared rules with their effective thresholds, and per-account
 *   collection status (the "why is this empty" answer).
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  idleRuleKey,
  resolveIdleThresholds,
  resolveRemediationCommands,
  type IdleMetricEvidence,
  type IdleRuleDeclaration,
  type IdleSavingsEstimate,
  type OrphanAccountGroup,
  type OrphanedResource,
  type Plugin,
  type RemediationSource,
} from "@infrawrench/plugin-base";
import type {
  IdleAccountStatus,
  IdleFindingSettings,
  IdleFindingsOverview,
  IdleRuleView,
} from "@infrawrench/client-core";

import { db } from "../db/client.js";
import { accountIdleFindings, accountIdlePolls, accounts, resources } from "../db/schema.js";
import { loadPlugins } from "../plugin-loader.js";
import { getOrgIdleSettings, isIdleRuleEnabled } from "./settings.js";

/** A stored verdict, as the merge reads it. */
export interface StoredIdleFinding {
  id: string;
  accountId: string;
  pluginId: string;
  ruleId: string;
  subjectKey: string;
  resourceId: string | null;
  resourceTypeId: string | null;
  displayName: string;
  subjectLabel: string | null;
  reason: string;
  evidence: IdleMetricEvidence[];
  estimate: IdleSavingsEstimate | null;
  fields: Record<string, string | number | boolean>;
  lookbackDays: number;
  firstDetectedAt: Date;
  evaluatedAt: Date;
}

/** The plugin metadata the merge reads. */
export interface IdleFeedPlugin extends RemediationSource {
  id: string;
  displayName: string;
  resourceTypes: readonly { id: string; displayName: string }[];
  rules: readonly IdleRuleDeclaration[];
}

/** The stored resource row an idle finding points at (non-deleted rows only). */
export interface IdleFeedResource {
  id: string;
  externalId: string | null;
  displayName: string;
  fields: Record<string, string | number | boolean>;
  lastSyncedAt: string | null;
}

/** Prefix of the row id for a finding with no resource row (a custom metric). */
export const IDLE_FINDING_ROW_PREFIX = "idle:";

/**
 * Merge stored idle verdicts into already-collected orphan groups, in place.
 *
 * Pure over its inputs. Skips: findings for a disabled rule or a rule the
 * plugin no longer declares, findings for an account that is gone, a
 * resource-backed finding whose resource row is gone (deleted since the last
 * collection), and a resource the orphan rule already flagged (one row per
 * resource; the cheaper, credential-free verdict wins).
 */
export function mergeIdleFindings(
  groups: OrphanAccountGroup[],
  input: {
    findings: readonly StoredIdleFinding[];
    settings: IdleFindingSettings;
    plugins: readonly IdleFeedPlugin[];
    accounts: readonly { id: string; displayName: string; pluginId: string }[];
    resourcesById: ReadonlyMap<string, IdleFeedResource>;
  },
): OrphanAccountGroup[] {
  if (!input.settings.enabled || input.findings.length === 0) return groups;
  const pluginById = new Map(input.plugins.map((p) => [p.id, p]));
  const accountById = new Map(input.accounts.map((a) => [a.id, a]));
  const groupByAccount = new Map(groups.map((g) => [g.accountId, g]));
  const flagged = new Set(groups.flatMap((g) => g.resources.map((r) => r.id)));
  const touched = new Set<OrphanAccountGroup>();

  for (const f of input.findings) {
    const plugin = pluginById.get(f.pluginId);
    const rule = plugin?.rules.find((r) => r.id === f.ruleId);
    if (!plugin || !rule) continue;
    const ruleKey = idleRuleKey(f.pluginId, f.ruleId);
    if (!isIdleRuleEnabled(input.settings, ruleKey)) continue;
    const account = accountById.get(f.accountId);
    if (!account) continue;

    let resource: IdleFeedResource | undefined;
    if (f.resourceId !== null) {
      resource = input.resourcesById.get(f.resourceId);
      if (!resource || flagged.has(resource.id)) continue;
    }

    const typeName =
      (f.resourceTypeId &&
        plugin.resourceTypes.find((t) => t.id === f.resourceTypeId)?.displayName) ||
      f.subjectLabel ||
      rule.label;
    const externalId = resource ? resource.externalId : f.subjectKey;
    const resourceTypeId = f.resourceTypeId ?? "";
    const displayName = resource?.displayName ?? f.displayName;
    const remediationFields = { ...(resource?.fields ?? {}), ...f.fields };

    const row: OrphanedResource = {
      id: resource ? resource.id : `${IDLE_FINDING_ROW_PREFIX}${f.id}`,
      pluginId: f.pluginId,
      resourceTypeId,
      resourceTypeName: typeName,
      displayName,
      externalId,
      reason: f.reason,
      cost: null,
      owner: null,
      lastSyncedAt: resource ? resource.lastSyncedAt : f.evaluatedAt.toISOString(),
      remediation: resolveRemediationCommands(plugin, {
        kind: "orphan",
        reason: f.reason,
        idleRuleId: f.ruleId,
        resource: { resourceTypeId, displayName, externalId, fields: remediationFields },
      }),
      idle: {
        ruleId: f.ruleId,
        ruleKey,
        ruleLabel: rule.label,
        action: rule.action,
        lookbackDays: f.lookbackDays,
        evidence: f.evidence,
        detectedAt: f.firstDetectedAt.toISOString(),
        evaluatedAt: f.evaluatedAt.toISOString(),
        hasResource: resource !== undefined,
      },
      estimate: f.estimate,
    };

    let group = groupByAccount.get(f.accountId);
    if (!group) {
      group = {
        accountId: f.accountId,
        accountName: account.displayName,
        pluginId: account.pluginId,
        pluginName: plugin.displayName,
        resources: [],
      };
      groupByAccount.set(f.accountId, group);
      groups.push(group);
    }
    group.resources.push(row);
    if (resource) flagged.add(resource.id);
    touched.add(group);
  }

  for (const g of touched) {
    g.resources.sort(
      (a, b) =>
        a.resourceTypeName.localeCompare(b.resourceTypeName) ||
        a.displayName.localeCompare(b.displayName),
    );
  }
  groups.sort((a, b) => a.accountName.localeCompare(b.accountName));
  return groups;
}

/** The org's stored verdicts. */
export async function loadStoredIdleFindings(organizationId: string): Promise<StoredIdleFinding[]> {
  return db
    .select({
      id: accountIdleFindings.id,
      accountId: accountIdleFindings.accountId,
      pluginId: accountIdleFindings.pluginId,
      ruleId: accountIdleFindings.ruleId,
      subjectKey: accountIdleFindings.subjectKey,
      resourceId: accountIdleFindings.resourceId,
      resourceTypeId: accountIdleFindings.resourceTypeId,
      displayName: accountIdleFindings.displayName,
      subjectLabel: accountIdleFindings.subjectLabel,
      reason: accountIdleFindings.reason,
      evidence: accountIdleFindings.evidence,
      estimate: accountIdleFindings.estimate,
      fields: accountIdleFindings.fields,
      lookbackDays: accountIdleFindings.lookbackDays,
      firstDetectedAt: accountIdleFindings.firstDetectedAt,
      evaluatedAt: accountIdleFindings.evaluatedAt,
    })
    .from(accountIdleFindings)
    .where(eq(accountIdleFindings.organizationId, organizationId));
}

/** Plugin metadata in the shape {@link mergeIdleFindings} reads. */
export function idleFeedPlugins(loaded: readonly { plugin: Plugin }[]): IdleFeedPlugin[] {
  return loaded
    .filter(({ plugin }) => plugin.manifest.idleFindings)
    .map(({ plugin }) => ({
      id: plugin.manifest.id,
      displayName: plugin.manifest.displayName,
      resourceTypes: plugin.resourceTypes,
      rules: plugin.manifest.idleFindings?.rules ?? [],
      remediationCommands: plugin.remediationCommands?.bind(plugin),
    }));
}

/**
 * The declared rules with the org's effective settings: pure, so the route
 * test and the CLI formatter can share it.
 */
export function buildIdleRuleViews(
  plugins: readonly {
    id: string;
    displayName: string;
    resourceTypes: readonly { id: string; displayName: string }[];
    rules: readonly IdleRuleDeclaration[];
  }[],
  settings: IdleFindingSettings,
): IdleRuleView[] {
  const views: IdleRuleView[] = [];
  for (const p of plugins) {
    for (const rule of p.rules) {
      const ruleKey = idleRuleKey(p.id, rule.id);
      const resolved = resolveIdleThresholds(rule, settings.rules[ruleKey]?.thresholds);
      views.push({
        ruleKey,
        pluginId: p.id,
        pluginName: p.displayName,
        ruleId: rule.id,
        label: rule.label,
        description: rule.description,
        action: rule.action,
        resourceTypeNames: rule.resourceTypeIds.map(
          (id) => p.resourceTypes.find((t) => t.id === id)?.displayName ?? id,
        ),
        enabled: settings.rules[ruleKey]?.enabled !== false,
        thresholds: rule.thresholds.map((t) => ({
          key: t.key,
          label: t.label,
          description: t.description ?? null,
          unit: t.unit,
          default: t.default,
          min: t.min,
          max: t.max,
          value: resolved[t.key] ?? t.default,
        })),
      });
    }
  }
  return views.sort(
    (a, b) => a.pluginName.localeCompare(b.pluginName) || a.label.localeCompare(b.label),
  );
}

/** `GET /idle-findings`: settings, the rule catalog and per-account collection status. */
export async function getIdleFindingsOverview(
  organizationId: string,
): Promise<IdleFindingsOverview> {
  const [settings, loaded] = await Promise.all([getOrgIdleSettings(organizationId), loadPlugins()]);
  const plugins = idleFeedPlugins(loaded);
  const rules = buildIdleRuleViews(plugins, settings);
  const pluginIds = plugins.map((p) => p.id);
  if (pluginIds.length === 0) return { settings, rules, accounts: [] };

  const [accountRows, polls, counts] = await Promise.all([
    db
      .select({ id: accounts.id, displayName: accounts.displayName, pluginId: accounts.pluginId })
      .from(accounts)
      .where(
        and(
          eq(accounts.organizationId, organizationId),
          isNull(accounts.deletedAt),
          inArray(accounts.pluginId, pluginIds),
        ),
      ),
    db.select().from(accountIdlePolls).where(eq(accountIdlePolls.organizationId, organizationId)),
    db
      .select({ accountId: accountIdleFindings.accountId })
      .from(accountIdleFindings)
      .where(eq(accountIdleFindings.organizationId, organizationId)),
  ]);
  const pollById = new Map(polls.map((p) => [p.accountId, p]));
  const countById = new Map<string, number>();
  for (const c of counts) countById.set(c.accountId, (countById.get(c.accountId) ?? 0) + 1);
  const nameById = new Map(plugins.map((p) => [p.id, p.displayName]));

  const statuses: IdleAccountStatus[] = accountRows
    .map((a) => {
      const poll = pollById.get(a.id);
      return {
        accountId: a.id,
        accountName: a.displayName,
        pluginId: a.pluginId,
        pluginName: nameById.get(a.pluginId) ?? a.pluginId,
        lastPolledAt: poll?.lastPolledAt ? poll.lastPolledAt.toISOString() : null,
        nextPollAt: poll?.nextPollAt ? poll.nextPollAt.toISOString() : null,
        lastError: poll?.lastError ?? null,
        helpLabel: poll?.lastErrorHelpLabel ?? null,
        helpUrl: poll?.lastErrorHelpUrl ?? null,
        findingCount: countById.get(a.id) ?? 0,
      };
    })
    .sort((a, b) => a.accountName.localeCompare(b.accountName));
  return { settings, rules, accounts: statuses };
}

/**
 * Count and list-price total of the org's live idle findings: enabled rules
 * only, and resource-backed findings only while their resource row exists.
 * The total is in the primary currency (the one with the most), the seats
 * line's convention. For the weekly digest.
 */
export async function summarizeIdleFindings(
  organizationId: string,
): Promise<{ findings: number; currency: string | null; monthly: number | null }> {
  const [settings, stored] = await Promise.all([
    getOrgIdleSettings(organizationId),
    loadStoredIdleFindings(organizationId),
  ]);
  if (!settings.enabled || stored.length === 0)
    return { findings: 0, currency: null, monthly: null };
  const enabled = stored.filter((f) =>
    isIdleRuleEnabled(settings, idleRuleKey(f.pluginId, f.ruleId)),
  );
  const resourceIds = [...new Set(enabled.flatMap((f) => (f.resourceId ? [f.resourceId] : [])))];
  const live = new Set(
    resourceIds.length === 0
      ? []
      : (
          await db
            .select({ id: resources.id })
            .from(resources)
            .where(and(inArray(resources.id, resourceIds), isNull(resources.deletedAt)))
        ).map((r) => r.id),
  );
  const kept = enabled.filter((f) => f.resourceId === null || live.has(f.resourceId));
  return { findings: kept.length, ...primaryEstimateTotal(kept) };
}

/** Sum list-price estimates per currency and keep the largest. Pure. */
export function primaryEstimateTotal(findings: readonly Pick<StoredIdleFinding, "estimate">[]): {
  currency: string | null;
  monthly: number | null;
} {
  const totals = new Map<string, number>();
  for (const f of findings) {
    if (!f.estimate) continue;
    totals.set(
      f.estimate.currency,
      (totals.get(f.estimate.currency) ?? 0) + f.estimate.monthlyAmount,
    );
  }
  let best: { currency: string; monthly: number } | null = null;
  for (const [currency, monthly] of totals) {
    if (!best || monthly > best.monthly) best = { currency, monthly };
  }
  return best
    ? { currency: best.currency, monthly: Math.round(best.monthly * 100) / 100 }
    : { currency: null, monthly: null };
}

/**
 * The stored idle verdict for one resource, when an enabled rule flags it:
 * how realized savings recognises a deletion of an idle resource as a saving.
 */
export async function findIdleFindingForResource(
  organizationId: string,
  resourceId: string,
): Promise<{ reason: string; estimate: IdleSavingsEstimate | null } | null> {
  const [rows, settings] = await Promise.all([
    db
      .select({
        pluginId: accountIdleFindings.pluginId,
        ruleId: accountIdleFindings.ruleId,
        reason: accountIdleFindings.reason,
        estimate: accountIdleFindings.estimate,
      })
      .from(accountIdleFindings)
      .where(
        and(
          eq(accountIdleFindings.organizationId, organizationId),
          eq(accountIdleFindings.resourceId, resourceId),
        ),
      )
      .limit(5),
    getOrgIdleSettings(organizationId),
  ]);
  const hit = rows.find((r) => isIdleRuleEnabled(settings, idleRuleKey(r.pluginId, r.ruleId)));
  return hit ? { reason: hit.reason, estimate: hit.estimate } : null;
}
