/**
 * Org-scoped metric alert rule CRUD + status — shared by the HTTP routes
 * (api/routes/metric-alerts.ts). Evaluation lives in
 * `server-core/src/metric-alerts/`; this module only reads/writes the rules
 * and their firing history, mirroring `services/budgets.ts`.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import type {
  MetricAlertEvent,
  MetricAlertRule,
  MetricAlertRuleInput,
  MetricAlertRuleWithStatus,
  MetricAlertSelector,
  MetricAlertSelectorOptions,
  MetricAlertSelectorPreview,
} from "@infrawrench/client-core";
import { extractRecordTags } from "@infrawrench/client-core";
import { resolveSelectorResources } from "@infrawrench/server-core/metric-alerts/selector";
import { db } from "../db/client";
import { metricAlertEvents, metricAlertRules, resources } from "../db/schema";

type RuleRow = typeof metricAlertRules.$inferSelect;

function toWireRule(row: RuleRow): MetricAlertRule {
  return {
    id: row.id,
    name: row.name,
    pluginId: row.pluginId,
    resourceTypeId: row.resourceTypeId,
    tagKey: row.tagKey,
    tagValue: row.tagValue,
    metricKey: row.metricKey,
    comparator: row.comparator,
    threshold: row.threshold,
    forMinutes: row.forMinutes,
    cooldownMinutes: row.cooldownMinutes,
    enabled: row.enabled,
    lastEvalAt: row.lastEvalAt ? row.lastEvalAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** List rules with live firing counts and current selector match counts. */
export async function listRulesWithStatus(
  organizationId: string,
): Promise<MetricAlertRuleWithStatus[]> {
  const rows = await db
    .select()
    .from(metricAlertRules)
    .where(
      and(eq(metricAlertRules.organizationId, organizationId), isNull(metricAlertRules.deletedAt)),
    )
    .orderBy(metricAlertRules.createdAt);
  if (rows.length === 0) return [];

  const firingRows = await db
    .select({ ruleId: metricAlertEvents.ruleId, n: sql<number>`count(*)` })
    .from(metricAlertEvents)
    .where(
      and(
        inArray(
          metricAlertEvents.ruleId,
          rows.map((r) => r.id),
        ),
        eq(metricAlertEvents.status, "firing"),
      ),
    )
    .groupBy(metricAlertEvents.ruleId);
  const firingByRule = new Map(firingRows.map((r) => [r.ruleId, Number(r.n)]));

  return Promise.all(
    rows.map(async (row) => {
      // The selector resolves against the live resources table, so the count
      // reflects resources created after the rule was written — the whole
      // point of query-based selection.
      let matching = 0;
      try {
        matching = (await resolveSelectorResources(row)).length;
      } catch {
        // A selector that cannot resolve reads as covering nothing rather
        // than failing the whole list.
      }
      return {
        ...toWireRule(row),
        firingCount: firingByRule.get(row.id) ?? 0,
        matchingResourceCount: matching,
      };
    }),
  );
}

/** Fetch one rule. Null when not found. */
export async function getRule(
  organizationId: string,
  ruleId: string,
): Promise<MetricAlertRule | null> {
  const [row] = await db
    .select()
    .from(metricAlertRules)
    .where(
      and(
        eq(metricAlertRules.id, ruleId),
        eq(metricAlertRules.organizationId, organizationId),
        isNull(metricAlertRules.deletedAt),
      ),
    )
    .limit(1);
  return row ? toWireRule(row) : null;
}

export async function createRule(
  organizationId: string,
  input: MetricAlertRuleInput,
  createdByUserId: string | null,
): Promise<MetricAlertRule> {
  const [created] = await db
    .insert(metricAlertRules)
    .values({
      id: uuidv4(),
      organizationId,
      name: input.name,
      pluginId: input.pluginId,
      resourceTypeId: input.resourceTypeId,
      tagKey: input.tagKey,
      tagValue: input.tagValue,
      metricKey: input.metricKey,
      comparator: input.comparator,
      threshold: input.threshold,
      forMinutes: input.forMinutes,
      cooldownMinutes: input.cooldownMinutes,
      enabled: input.enabled,
      // Null = "due now": the poller's next metric-alert pass picks it up.
      nextEvalAt: null,
      createdByUserId,
    })
    .returning();
  return toWireRule(created!);
}

/** Update a rule. Null when not found. */
export async function updateRule(
  organizationId: string,
  ruleId: string,
  input: MetricAlertRuleInput,
): Promise<MetricAlertRule | null> {
  const [updated] = await db
    .update(metricAlertRules)
    .set({
      name: input.name,
      pluginId: input.pluginId,
      resourceTypeId: input.resourceTypeId,
      tagKey: input.tagKey,
      tagValue: input.tagValue,
      metricKey: input.metricKey,
      comparator: input.comparator,
      threshold: input.threshold,
      forMinutes: input.forMinutes,
      cooldownMinutes: input.cooldownMinutes,
      enabled: input.enabled,
      // Re-evaluate promptly under the new definition.
      nextEvalAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(metricAlertRules.id, ruleId),
        eq(metricAlertRules.organizationId, organizationId),
        isNull(metricAlertRules.deletedAt),
      ),
    )
    .returning();
  return updated ? toWireRule(updated) : null;
}

/** Soft-delete a rule. Its event history stays readable. False when not found. */
export async function softDeleteRule(organizationId: string, ruleId: string): Promise<boolean> {
  const now = new Date();
  const [deleted] = await db
    .update(metricAlertRules)
    .set({ deletedAt: now, enabled: false, updatedAt: now })
    .where(
      and(
        eq(metricAlertRules.id, ruleId),
        eq(metricAlertRules.organizationId, organizationId),
        isNull(metricAlertRules.deletedAt),
      ),
    )
    .returning({ id: metricAlertRules.id });
  if (!deleted) return false;

  // Anything still firing is closed quietly — the rule no longer exists, so
  // there is nothing to recover from and nobody to notify.
  await db
    .update(metricAlertEvents)
    .set({ status: "resolved", resolvedAt: now })
    .where(and(eq(metricAlertEvents.ruleId, ruleId), eq(metricAlertEvents.status, "firing")));
  return true;
}

/** Recent firings, org-wide or for one rule. Newest first. */
export async function listEvents(
  organizationId: string,
  options: { ruleId?: string | undefined; limit?: number | undefined } = {},
): Promise<MetricAlertEvent[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const rows = await db
    .select({
      id: metricAlertEvents.id,
      ruleId: metricAlertEvents.ruleId,
      ruleName: metricAlertRules.name,
      resourceId: metricAlertEvents.resourceId,
      resourceName: metricAlertEvents.resourceName,
      status: metricAlertEvents.status,
      observedValue: metricAlertEvents.observedValue,
      firedAt: metricAlertEvents.firedAt,
      resolvedAt: metricAlertEvents.resolvedAt,
    })
    .from(metricAlertEvents)
    .innerJoin(metricAlertRules, eq(metricAlertRules.id, metricAlertEvents.ruleId))
    .where(
      and(
        eq(metricAlertEvents.organizationId, organizationId),
        ...(options.ruleId ? [eq(metricAlertEvents.ruleId, options.ruleId)] : []),
      ),
    )
    .orderBy(desc(metricAlertEvents.firedAt))
    .limit(limit);

  return rows.map((e) => ({
    id: e.id,
    ruleId: e.ruleId,
    ruleName: e.ruleName,
    resourceId: e.resourceId,
    resourceName: e.resourceName,
    status: e.status,
    observedValue: e.observedValue,
    firedAt: e.firedAt.toISOString(),
    resolvedAt: e.resolvedAt ? e.resolvedAt.toISOString() : null,
  }));
}

/**
 * What the org's resources actually offer to select on. The pickers are fed
 * from this instead of the full plugin catalog, so the form never offers a
 * provider or tag the org has no resources for. Tag keys are read from a
 * bounded sample of the newest resources — enough to enumerate an org's
 * tagging vocabulary without an unbounded JSONB scan.
 */
export async function listSelectorOptions(
  organizationId: string,
): Promise<MetricAlertSelectorOptions> {
  const pairRows = await db
    .selectDistinct({ pluginId: resources.pluginId, resourceTypeId: resources.resourceTypeId })
    .from(resources)
    .where(and(eq(resources.organizationId, organizationId), isNull(resources.deletedAt)))
    .orderBy(resources.pluginId, resources.resourceTypeId);

  const byPlugin = new Map<string, string[]>();
  for (const row of pairRows) {
    const list = byPlugin.get(row.pluginId) ?? [];
    list.push(row.resourceTypeId);
    byPlugin.set(row.pluginId, list);
  }

  const tagRows = await db
    .select({ fieldsJson: resources.fieldsJson, outputsJson: resources.outputsJson })
    .from(resources)
    .where(and(eq(resources.organizationId, organizationId), isNull(resources.deletedAt)))
    .orderBy(desc(resources.updatedAt))
    .limit(2000);
  const tagKeys = new Set<string>();
  for (const row of tagRows) {
    const tags = extractRecordTags({ ...row.outputsJson, ...row.fieldsJson });
    if (!tags) continue;
    for (const key of Object.keys(tags)) tagKeys.add(key);
  }

  return {
    plugins: [...byPlugin.entries()].map(([pluginId, resourceTypeIds]) => ({
      pluginId,
      resourceTypeIds,
    })),
    tagKeys: [...tagKeys].sort((a, b) => a.localeCompare(b)),
  };
}

/** What a selector matches right now — the form's "who does this cover?" preview. */
export async function previewSelector(
  organizationId: string,
  selector: MetricAlertSelector,
): Promise<MetricAlertSelectorPreview> {
  const matched = await resolveSelectorResources({ organizationId, ...selector });
  return {
    matchingResourceCount: matched.length,
    sampleResourceNames: matched.slice(0, 10).map((r) => r.displayName),
  };
}
