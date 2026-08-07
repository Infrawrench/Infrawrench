/**
 * Org config as code — export the organization's configuration as one JSON
 * document, and apply a document back.
 *
 * Shared by the HTTP routes (`api/routes/org-config.ts`) and anything else that
 * wants the same code path, the way `services/budgets.ts` backs both its route
 * and the tool registry. Everything here is transport-agnostic: it takes an
 * organizationId, returns plain data, and reports user-correctable problems as
 * {@link OrgConfigError}.
 *
 * ## How apply works
 *
 * 1. **Read** the org's current configuration once ({@link loadOrgConfigState}),
 *    in exactly the document's shape.
 * 2. **Plan** — match document entities to existing rows by `key`, classify each
 *    as create / update / unchanged, and (in `replace` mode) mark what the
 *    document does not name as delete. References between sections are resolved
 *    here, while nothing has been written; anything that cannot resolve is
 *    reported and dropped, never invented.
 * 3. **Execute** every planned write inside one `db.transaction`. An apply is
 *    all or nothing — a document that fails halfway through would leave an org
 *    in a state that is neither the old configuration nor the new one, which is
 *    the exact failure disaster recovery exists to avoid.
 *
 * A plan is also the dry run: `POST /config/plan` runs steps 1–2 and stops.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import {
  ORG_CONFIG_SECTIONS,
  ORG_CONFIG_VERSION,
  PROBE_LIMITS,
  nextCronOccurrence,
  normalizeProbeMethod,
  normalizeProbeUrl,
  tallyOrgConfigChanges,
  type OrgConfigApplyMode,
  type OrgConfigApplyResult,
  type OrgConfigChange,
  type OrgConfigDashboard,
  type OrgConfigDashboardCard,
  type OrgConfigDocument,
  type OrgConfigPlan,
  type OrgConfigSection,
  type OrgConfigUnresolved,
  type OrgConfigWorkflowTrigger,
} from "@infrawrench/client-core";
import { widgetConfigSchemaFor, type DashboardWidgetKind } from "@infrawrench/ui/cost/config";
import { normalizeAnomalySettings } from "@infrawrench/server-core/cost/anomaly-settings";
import { normalizeTagPolicy } from "@infrawrench/server-core/cost/tag-policy";
import { digestWindow, isValidTimeZone } from "@infrawrench/server-core/digest/compose";
import { normalizeEmailAddress } from "@infrawrench/server-core/email";
import { db } from "../../db/client";
import {
  budgets,
  costAllocationRules,
  costCentres,
  customGraphData,
  customGraphs,
  dashboardPins,
  dashboardWidgets,
  dashboardWorkflowPins,
  dashboards,
  digestEmailRecipients,
  metricAlertEvents,
  metricAlertRules,
  orgCostAnomalySettings,
  orgDigestSettings,
  orgDriftAlertSettings,
  orgExpirySettings,
  orgPostureSettings,
  orgTagPolicies,
  resources,
  syntheticProbes,
  workflows,
} from "../../db/schema";
import { requirePaidPlan } from "../entitlements";
import { OrgConfigError, type ParsedOrgConfigDocument } from "./schema";
import { loadOrgConfigState, type OrgConfigEntity, type OrgConfigState } from "./state";

export { OrgConfigError, orgConfigDocumentSections, parseOrgConfigDocument } from "./schema";

/** The transaction handle drizzle hands the callback. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A planned write, deferred until the transaction opens. */
type Operation = (tx: Tx) => Promise<void>;

/* ---------------------------------- export --------------------------------- */

interface ExportOrgConfigOptions {
  organizationName: string;
  /** Only these sections. Omitted (or empty) means every section. */
  sections?: readonly OrgConfigSection[] | undefined;
  now?: Date;
}

/**
 * The org's configuration as one document.
 *
 * Ordering is stable across calls (see `state.ts`) and object keys are emitted
 * in a fixed order, so re-exporting an unchanged org produces a byte-identical
 * file — which is what makes committing the export to git useful rather than
 * noisy.
 */
export async function exportOrgConfig(
  organizationId: string,
  opts: ExportOrgConfigOptions,
): Promise<OrgConfigDocument> {
  const state = await loadOrgConfigState(organizationId);
  const wanted = new Set<OrgConfigSection>(
    opts.sections?.length ? opts.sections : ORG_CONFIG_SECTIONS,
  );
  const want = (section: OrgConfigSection) => wanted.has(section);

  return {
    version: ORG_CONFIG_VERSION,
    exportedAt: (opts.now ?? new Date()).toISOString(),
    exportedFrom: { organizationId, organizationName: opts.organizationName },
    ...(want("budgets") ? { budgets: state.budgets.map((b) => b.config) } : {}),
    ...(want("customGraphs") ? { customGraphs: state.customGraphs.map((g) => g.config) } : {}),
    ...(want("workflows") ? { workflows: state.workflows.map((w) => w.config) } : {}),
    ...(want("dashboards") ? { dashboards: state.dashboards.map((d) => d.config) } : {}),
    ...(want("metricAlerts") ? { metricAlerts: state.metricAlerts.map((a) => a.config) } : {}),
    ...(want("probes") ? { probes: state.probes.map((p) => p.config) } : {}),
    ...(want("costCentres") ? { costCentres: state.costCentres.map((c) => c.config) } : {}),
    ...(want("tagPolicy") ? { tagPolicy: state.tagPolicy } : {}),
    ...(want("alertSettings") ? { alertSettings: state.alertSettings } : {}),
  };
}

/* ----------------------------------- diff ---------------------------------- */

/** Canonical JSON: object keys sorted, `undefined` dropped, for value equality. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const inner = (value as Record<string, unknown>)[key];
      if (inner === undefined) continue;
      out[key] = canonical(inner);
    }
    return out;
  }
  return value;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** Top-level fields (excluding `key`) whose values differ. */
function changedFields(current: object, next: object): string[] {
  const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
  keys.delete("key");
  const fields: string[] = [];
  for (const field of [...keys].sort()) {
    const a = (current as Record<string, unknown>)[field];
    const b = (next as Record<string, unknown>)[field];
    if (!sameValue(a, b)) fields.push(field);
  }
  return fields;
}

/* ----------------------------------- plan ---------------------------------- */

/** Everything a plan accumulates while it is being built. */
class PlanBuilder {
  readonly changes: OrgConfigChange[] = [];
  readonly unresolved: OrgConfigUnresolved[] = [];
  readonly operations: Operation[] = [];

  record(
    section: OrgConfigSection,
    key: string,
    name: string,
    action: OrgConfigChange["action"],
    fields?: string[],
  ) {
    this.changes.push({
      section,
      key,
      name,
      action,
      ...(fields && fields.length > 0 ? { fields } : {}),
    });
  }

  miss(section: OrgConfigSection, key: string, detail: string) {
    this.unresolved.push({ section, key, detail });
  }

  op(operation: Operation) {
    this.operations.push(operation);
  }
}

/**
 * Walk one collection section: pair document entries with existing rows by key,
 * classify each, and (in replace mode) mark the leftovers for deletion.
 *
 * `onCreate`/`onUpdate`/`onDelete` queue the writes; the id of a created row is
 * minted here so later sections can point at it before it exists.
 */
function planCollection<T extends { key: string; name: string }>(
  plan: PlanBuilder,
  section: OrgConfigSection,
  mode: OrgConfigApplyMode,
  existing: OrgConfigEntity<T>[],
  incoming: T[] | undefined,
  handlers: {
    create: (id: string, entry: T) => Operation;
    update: (id: string, entry: T, current: T) => Operation;
    remove: (entity: OrgConfigEntity<T>) => Operation | null;
  },
): Map<string, string> {
  /** Document key → row id, for cross-section references. */
  const idByKey = new Map<string, string>();
  for (const entity of existing) idByKey.set(entity.key, entity.id);
  if (incoming === undefined) return idByKey;

  const byKey = new Map(existing.map((e) => [e.key, e]));
  const named = new Set<string>();

  for (const entry of incoming) {
    named.add(entry.key);
    const current = byKey.get(entry.key);
    if (!current) {
      const id = uuidv4();
      idByKey.set(entry.key, id);
      plan.record(section, entry.key, entry.name, "create");
      plan.op(handlers.create(id, entry));
      continue;
    }
    const fields = changedFields(current.config, entry);
    if (fields.length === 0) {
      plan.record(section, entry.key, entry.name, "unchanged");
      continue;
    }
    plan.record(section, entry.key, entry.name, "update", fields);
    plan.op(handlers.update(current.id, entry, current.config));
  }

  if (mode === "replace") {
    for (const entity of existing) {
      if (named.has(entity.key)) continue;
      const operation = handlers.remove(entity);
      if (!operation) continue;
      plan.record(section, entity.key, entity.config.name, "delete");
      plan.op(operation);
    }
  }
  return idByKey;
}

interface PlanOrgConfigOptions {
  mode: OrgConfigApplyMode;
  /** Whose permissions a re-authored custom-graph script runs as. */
  userId: string | null;
}

interface BuiltPlan {
  plan: OrgConfigPlan;
  operations: Operation[];
  /** True when the document writes or rewrites a custom graph (plan-gated). */
  touchesCustomGraphs: boolean;
}

async function buildOrgConfigPlan(
  organizationId: string,
  doc: ParsedOrgConfigDocument,
  opts: PlanOrgConfigOptions,
): Promise<BuiltPlan> {
  const state = await loadOrgConfigState(organizationId);
  const plan = new PlanBuilder();
  const { mode } = opts;
  const now = new Date();

  // --- budgets -------------------------------------------------------------
  const budgetIdByKey = planCollection(plan, "budgets", mode, state.budgets, doc.budgets, {
    create: (id, entry) => async (tx) => {
      await tx.insert(budgets).values({
        id,
        organizationId,
        name: entry.name,
        amountCents: entry.amountCents,
        currency: entry.currency,
        filters: entry.filters,
        thresholds: entry.thresholds,
        createdByUserId: opts.userId,
      });
    },
    update: (id, entry) => async (tx) => {
      await tx
        .update(budgets)
        .set({
          name: entry.name,
          amountCents: entry.amountCents,
          currency: entry.currency,
          filters: entry.filters,
          thresholds: entry.thresholds,
          updatedAt: now,
        })
        .where(eq(budgets.id, id));
    },
    // Mirrors `softDeleteBudget`: a budget's cards go with it, because a card
    // whose budget is gone renders as a permanent "unavailable" tile.
    remove: (entity) => async (tx) => {
      await tx
        .update(budgets)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(budgets.id, entity.id));
      await tx
        .update(dashboardWidgets)
        .set({ deletedAt: now, updatedAt: now })
        .where(
          and(
            eq(dashboardWidgets.organizationId, organizationId),
            eq(dashboardWidgets.kind, "budget"),
            isNull(dashboardWidgets.deletedAt),
            eq(sql`${dashboardWidgets.config} ->> 'budgetId'`, entity.id),
          ),
        );
    },
  });

  // --- custom graphs -------------------------------------------------------
  let touchesCustomGraphs = false;
  const graphIdByKey = planCollection(
    plan,
    "customGraphs",
    mode,
    state.customGraphs,
    doc.customGraphs,
    {
      create: (id, entry) => {
        touchesCustomGraphs = true;
        return async (tx) => {
          await tx.insert(customGraphs).values({
            id,
            organizationId,
            name: entry.name,
            description: entry.description?.trim() || null,
            source: entry.source,
            createdByUserId: opts.userId,
            // Same rule as the editor: `infra.*` inside the script runs with
            // the permissions of whoever last wrote the source — here, whoever
            // applied the document.
            sourceAuthorUserId: opts.userId,
          });
        };
      },
      update: (id, entry, current) => {
        touchesCustomGraphs = true;
        const sourceChanged = current.source !== entry.source;
        return async (tx) => {
          await tx
            .update(customGraphs)
            .set({
              name: entry.name,
              description: entry.description?.trim() || null,
              source: entry.source,
              ...(sourceChanged ? { sourceAuthorUserId: opts.userId } : {}),
              updatedAt: now,
            })
            .where(eq(customGraphs.id, id));
        };
      },
      remove: (entity) => async (tx) => {
        await tx
          .update(customGraphs)
          .set({ deletedAt: now, updatedAt: now })
          .where(eq(customGraphs.id, entity.id));
        await tx
          .update(dashboardWidgets)
          .set({ deletedAt: now, updatedAt: now })
          .where(
            and(
              eq(dashboardWidgets.organizationId, organizationId),
              eq(dashboardWidgets.kind, "custom_graph"),
              isNull(dashboardWidgets.deletedAt),
              eq(sql`${dashboardWidgets.config} ->> 'graphId'`, entity.id),
            ),
          );
        await tx
          .delete(customGraphData)
          .where(
            and(
              eq(customGraphData.organizationId, organizationId),
              eq(customGraphData.graphId, entity.id),
            ),
          );
      },
    },
  );

  // --- workflows -----------------------------------------------------------
  const existingWebhookTokens = await loadWebhookTokens(
    organizationId,
    state.workflows.map((w) => w.id),
  );

  const workflowIdByKey = planCollection(plan, "workflows", mode, state.workflows, doc.workflows, {
    create: (id, entry) => {
      const trigger = resolveTrigger(plan, entry.key, entry.trigger, budgetIdByKey);
      const derived = triggerDerived(trigger, entry.enabled, null);
      return async (tx) => {
        await tx.insert(workflows).values({
          id,
          organizationId,
          name: entry.name,
          description: entry.description ?? null,
          source: entry.source,
          trigger,
          metricDefs: entry.metrics,
          enabled: entry.enabled,
          webhookToken: derived.webhookToken,
          nextRunAt: derived.nextRunAt,
          createdByUserId: opts.userId,
        });
      };
    },
    update: (id, entry) => {
      const trigger = resolveTrigger(plan, entry.key, entry.trigger, budgetIdByKey);
      const derived = triggerDerived(trigger, entry.enabled, existingWebhookTokens.get(id) ?? null);
      return async (tx) => {
        await tx
          .update(workflows)
          .set({
            name: entry.name,
            description: entry.description ?? null,
            source: entry.source,
            trigger,
            metricDefs: entry.metrics,
            enabled: entry.enabled,
            webhookToken: derived.webhookToken,
            nextRunAt: derived.nextRunAt,
            updatedAt: now,
          })
          .where(eq(workflows.id, id));
        // The git signing secret is write-only by contract (it never leaves the
        // server, so no document can carry it) — leave whatever is stored.
      };
    },
    remove: (entity) => async (tx) => {
      await tx
        .update(workflows)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(workflows.id, entity.id));
    },
  });

  // --- dashboards ----------------------------------------------------------
  await planDashboards(plan, {
    organizationId,
    mode,
    now,
    state,
    incoming: doc.dashboards,
    budgetIdByKey,
    graphIdByKey,
    workflowIdByKey,
  });

  // --- metric alerts -------------------------------------------------------
  planCollection(plan, "metricAlerts", mode, state.metricAlerts, doc.metricAlerts, {
    create: (id, entry) => async (tx) => {
      await tx.insert(metricAlertRules).values({
        id,
        organizationId,
        name: entry.name,
        pluginId: entry.pluginId,
        resourceTypeId: entry.resourceTypeId,
        tagKey: entry.tagKey,
        tagValue: entry.tagValue,
        metricKey: entry.metricKey,
        comparator: entry.comparator,
        threshold: entry.threshold,
        forMinutes: entry.forMinutes,
        cooldownMinutes: entry.cooldownMinutes,
        enabled: entry.enabled,
        // Null = "due now": the poller's next pass picks it up.
        nextEvalAt: null,
        createdByUserId: opts.userId,
      });
    },
    update: (id, entry) => async (tx) => {
      await tx
        .update(metricAlertRules)
        .set({
          name: entry.name,
          pluginId: entry.pluginId,
          resourceTypeId: entry.resourceTypeId,
          tagKey: entry.tagKey,
          tagValue: entry.tagValue,
          metricKey: entry.metricKey,
          comparator: entry.comparator,
          threshold: entry.threshold,
          forMinutes: entry.forMinutes,
          cooldownMinutes: entry.cooldownMinutes,
          enabled: entry.enabled,
          nextEvalAt: null,
          updatedAt: now,
        })
        .where(eq(metricAlertRules.id, id));
    },
    // Mirrors `softDeleteRule`: anything still firing closes quietly, because
    // the rule no longer exists and there is nothing to recover from.
    remove: (entity) => async (tx) => {
      await tx
        .update(metricAlertRules)
        .set({ deletedAt: now, enabled: false, updatedAt: now })
        .where(eq(metricAlertRules.id, entity.id));
      await tx
        .update(metricAlertEvents)
        .set({ status: "resolved", resolvedAt: now })
        .where(
          and(eq(metricAlertEvents.ruleId, entity.id), eq(metricAlertEvents.status, "firing")),
        );
    },
  });

  // --- probes --------------------------------------------------------------
  if (doc.probes) {
    const kept = mode === "replace" ? doc.probes.length : countProbesAfterMerge(state, doc.probes);
    if (kept > PROBE_LIMITS.maxPerOrg) {
      throw new OrgConfigError(
        `This document would leave ${kept} synthetic probes; the limit is ${PROBE_LIMITS.maxPerOrg}.`,
      );
    }
  }
  planCollection(plan, "probes", mode, state.probes, doc.probes, {
    create: (id, entry) => {
      const url = requireProbeUrl(entry.name, entry.url);
      return async (tx) => {
        await tx.insert(syntheticProbes).values({
          id,
          organizationId,
          name: entry.name,
          url,
          method: normalizeProbeMethod(entry.method),
          intervalSeconds: entry.intervalSeconds,
          timeoutMs: entry.timeoutMs,
          failureThreshold: entry.failureThreshold,
          enabled: entry.enabled,
          createdByUserId: opts.userId,
        });
      };
    },
    update: (id, entry) => {
      const url = requireProbeUrl(entry.name, entry.url);
      return async (tx) => {
        await tx
          .update(syntheticProbes)
          .set({
            name: entry.name,
            url,
            method: normalizeProbeMethod(entry.method),
            intervalSeconds: entry.intervalSeconds,
            timeoutMs: entry.timeoutMs,
            failureThreshold: entry.failureThreshold,
            enabled: entry.enabled,
            updatedAt: now,
          })
          .where(eq(syntheticProbes.id, id));
      };
    },
    remove: (entity) => async (tx) => {
      await tx.delete(syntheticProbes).where(eq(syntheticProbes.id, entity.id));
    },
  });

  // --- cost centres --------------------------------------------------------
  planCollection(plan, "costCentres", mode, state.costCentres, doc.costCentres, {
    create: (id, entry) => {
      const rules = resolveAllocationRules(plan, entry.key, entry.rules, state);
      return async (tx) => {
        await tx.insert(costCentres).values({
          id,
          organizationId,
          name: entry.name,
          description: entry.description ?? null,
        });
        await writeAllocationRules(tx, organizationId, id, rules);
      };
    },
    update: (id, entry) => {
      const rules = resolveAllocationRules(plan, entry.key, entry.rules, state);
      return async (tx) => {
        await tx
          .update(costCentres)
          .set({ name: entry.name, description: entry.description ?? null, updatedAt: now })
          .where(eq(costCentres.id, id));
        // Rules are anonymous — the document's list is the whole list, so the
        // only sound update is to replace it.
        await tx.delete(costAllocationRules).where(eq(costAllocationRules.costCentreId, id));
        await writeAllocationRules(tx, organizationId, id, rules);
      };
    },
    remove: (entity) => async (tx) => {
      // The FK cascade takes the centre's rules with it.
      await tx.delete(costCentres).where(eq(costCentres.id, entity.id));
    },
  });

  // --- tag policy ----------------------------------------------------------
  if (doc.tagPolicy) {
    const next = normalizeTagPolicy(doc.tagPolicy);
    if (sameValue(state.tagPolicy, next)) {
      plan.record("tagPolicy", "tag-policy", "Tag policy", "unchanged");
    } else {
      plan.record(
        "tagPolicy",
        "tag-policy",
        "Tag policy",
        "update",
        changedFields(state.tagPolicy, next),
      );
      plan.op(async (tx) => {
        await tx
          .insert(orgTagPolicies)
          .values({
            organizationId,
            requiredTags: next.requiredTags,
            enforceOnCreate: next.enforceOnCreate,
          })
          .onConflictDoUpdate({
            target: orgTagPolicies.organizationId,
            set: {
              requiredTags: next.requiredTags,
              enforceOnCreate: next.enforceOnCreate,
              updatedAt: now,
            },
          });
      });
    }
  }

  // --- alert settings ------------------------------------------------------
  planAlertSettings(plan, { organizationId, now, state, incoming: doc.alertSettings });

  return {
    plan: {
      mode,
      changes: plan.changes,
      unresolved: plan.unresolved,
      counts: tallyOrgConfigChanges(plan.changes),
    },
    operations: plan.operations,
    touchesCustomGraphs,
  };
}

/** How many probes the org would have after a merge apply. */
function countProbesAfterMerge(state: OrgConfigState, incoming: Array<{ key: string }>): number {
  const existing = new Set(state.probes.map((p) => p.key));
  let total = existing.size;
  for (const entry of incoming) if (!existing.has(entry.key)) total += 1;
  return total;
}

function requireProbeUrl(name: string, raw: string): string {
  const result = normalizeProbeUrl(raw);
  if ("error" in result) throw new OrgConfigError(`Probe "${name}": ${result.error}`);
  return result.url;
}

/** Document trigger → stored trigger jsonb, resolving the budget reference. */
function resolveTrigger(
  plan: PlanBuilder,
  workflowKey: string,
  trigger: OrgConfigWorkflowTrigger,
  budgetIdByKey: Map<string, string>,
): Record<string, unknown> {
  if (trigger.kind !== "budget") return { ...trigger };
  const budgetId = budgetIdByKey.get(trigger.budgetKey);
  if (!budgetId) {
    // A budget trigger with no budget would save cleanly and then silently
    // never fire — the exact failure `validateTrigger` exists to prevent. Fall
    // back to manual and say so.
    plan.miss(
      "workflows",
      workflowKey,
      `budget trigger names "${trigger.budgetKey}", which is not in this document or this organization — the workflow is set to manual`,
    );
    return { kind: "manual" };
  }
  return {
    kind: "budget",
    budgetId,
    ...(trigger.percent !== undefined ? { percent: trigger.percent } : {}),
    ...(trigger.metric !== undefined ? { metric: trigger.metric } : {}),
  };
}

/** Scheduling/secret columns a trigger implies (mirrors `services/workflows.ts`). */
function triggerDerived(
  trigger: Record<string, unknown>,
  enabled: boolean,
  existingWebhookToken: string | null,
): { nextRunAt: Date | null; webhookToken: string | null } {
  if (trigger["kind"] === "cron" && enabled) {
    let nextRunAt: Date | null = null;
    try {
      const timezone = trigger["timezone"];
      nextRunAt = nextCronOccurrence(String(trigger["expression"] ?? ""), {
        ...(typeof timezone === "string" && timezone ? { timezone } : {}),
      });
    } catch {
      // An expression that never matches leaves the workflow unscheduled rather
      // than failing the whole apply — the same stance the editor takes.
      nextRunAt = null;
    }
    return { nextRunAt, webhookToken: existingWebhookToken };
  }
  if (trigger["kind"] === "git") {
    return { nextRunAt: null, webhookToken: existingWebhookToken ?? crypto.randomUUID() };
  }
  return { nextRunAt: null, webhookToken: existingWebhookToken };
}

async function loadWebhookTokens(
  organizationId: string,
  ids: string[],
): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: workflows.id, webhookToken: workflows.webhookToken })
    .from(workflows)
    .where(and(eq(workflows.organizationId, organizationId), inArray(workflows.id, ids)));
  return new Map(rows.map((r) => [r.id, r.webhookToken]));
}

/* -------------------------------- dashboards ------------------------------- */

interface DashboardPlanArgs {
  organizationId: string;
  mode: OrgConfigApplyMode;
  now: Date;
  state: OrgConfigState;
  incoming: OrgConfigDashboard[] | undefined;
  budgetIdByKey: Map<string, string>;
  graphIdByKey: Map<string, string>;
  workflowIdByKey: Map<string, string>;
}

/**
 * Dashboards, whose cards are the one part of the document that references
 * everything else.
 *
 * A dashboard's cards are anonymous and ordered, so — like allocation rules —
 * the only sound update is to replace the whole set. That is done only when the
 * card list actually differs, so an unchanged document does not churn widget
 * ids on every apply.
 */
async function planDashboards(plan: PlanBuilder, args: DashboardPlanArgs): Promise<void> {
  const { organizationId, mode, now, state, incoming } = args;
  if (incoming === undefined) return;

  const byKey = new Map(state.dashboards.map((d) => [d.key, d]));
  const named = new Set<string>();
  const wantsDefault = incoming.find((d) => d.isDefault);
  /** Row id of the dashboard the document marks default, existing or new. */
  let defaultDashboardId: string | null = null;

  for (const entry of incoming) {
    named.add(entry.key);
    const resolved = resolveCards(plan, entry, args);
    const current = byKey.get(entry.key);
    const next = { ...entry, cards: resolved.cards };

    if (!current) {
      const id = uuidv4();
      if (entry.isDefault) defaultDashboardId = id;
      plan.record("dashboards", entry.key, entry.name, "create");
      plan.op(async (tx) => {
        await tx
          .insert(dashboards)
          .values({ id, organizationId, name: entry.name, isDefault: entry.isDefault });
        await writeCards(tx, organizationId, id, resolved.rows, now);
      });
      continue;
    }

    if (entry.isDefault) defaultDashboardId = current.id;
    const fields = changedFields(current.config, next);
    if (fields.length === 0) {
      plan.record("dashboards", entry.key, entry.name, "unchanged");
      continue;
    }
    plan.record("dashboards", entry.key, entry.name, "update", fields);
    const rebuildCards = fields.includes("cards");
    plan.op(async (tx) => {
      await tx
        .update(dashboards)
        .set({ name: entry.name, isDefault: entry.isDefault, updatedAt: now })
        .where(eq(dashboards.id, current.id));
      if (rebuildCards) {
        await clearCards(tx, organizationId, current.id, now);
        await writeCards(tx, organizationId, current.id, resolved.rows, now);
      }
    });
  }

  // Exactly one default: the document's choice wins and every other dashboard
  // is demoted in the same transaction, so the org never ends up with two (the
  // "get or create the default" read would then pick one at random).
  if (defaultDashboardId) {
    const winner = defaultDashboardId;
    plan.op(async (tx) => {
      await tx
        .update(dashboards)
        .set({ isDefault: false, updatedAt: now })
        .where(and(eq(dashboards.organizationId, organizationId), eq(dashboards.isDefault, true)));
      await tx
        .update(dashboards)
        .set({ isDefault: true, updatedAt: now })
        .where(and(eq(dashboards.organizationId, organizationId), eq(dashboards.id, winner)));
    });
  }

  if (mode !== "replace") return;
  for (const entity of state.dashboards) {
    if (named.has(entity.key)) continue;
    if (entity.config.isDefault && !wantsDefault) {
      // The default dashboard is the org's home screen; the hand-editing route
      // refuses to delete it too. Leaving it is strictly recoverable — deleting
      // it is not.
      plan.miss(
        "dashboards",
        entity.key,
        "kept: this is the default dashboard, and the document names no replacement",
      );
      continue;
    }
    plan.record("dashboards", entity.key, entity.config.name, "delete");
    plan.op(async (tx) => {
      // Widgets and both pin tables cascade off the dashboard row.
      await tx.delete(dashboards).where(eq(dashboards.id, entity.id));
    });
  }
}

/** A card resolved to concrete row values, ready to insert. */
type CardRow =
  | {
      kind: "widget";
      widgetKind: DashboardWidgetKind;
      title: string;
      config: unknown;
      gridW: number;
      gridH: number;
    }
  | { kind: "workflow"; workflowId: string }
  | {
      kind: "resource";
      /** Looked up in the live `resources` table when the transaction runs. */
      accountId: string;
      pluginId: string;
      resourceTypeId: string;
      externalId: string;
      gridW: number;
      gridH: number;
    };

/**
 * Turn a dashboard's document cards into insertable rows, dropping — and
 * reporting — every card whose target this org does not have.
 *
 * The returned `cards` is the document form of what survived, so the diff
 * compares like with like: a pin that can never resolve here must not make the
 * dashboard read as "changed" on every single apply.
 */
function resolveCards(
  plan: PlanBuilder,
  dashboard: OrgConfigDashboard,
  args: DashboardPlanArgs,
): { rows: CardRow[]; cards: OrgConfigDashboardCard[] } {
  const rows: CardRow[] = [];
  const cards: OrgConfigDashboardCard[] = [];

  for (const card of dashboard.cards) {
    if (card.kind === "workflow") {
      const workflowId = args.workflowIdByKey.get(card.workflowKey);
      if (!workflowId) {
        plan.miss(
          "dashboards",
          dashboard.key,
          `workflow card names "${card.workflowKey}", which is not in this document or this organization`,
        );
        continue;
      }
      rows.push({ kind: "workflow", workflowId });
      cards.push(card);
      continue;
    }

    if (card.kind === "resource") {
      const accountId = args.state.accountIdByName.get(card.account.toLowerCase());
      if (!accountId) {
        plan.miss(
          "dashboards",
          dashboard.key,
          `resource card needs account "${card.account}", which this organization has not connected`,
        );
        continue;
      }
      rows.push({
        kind: "resource",
        accountId,
        pluginId: card.pluginId,
        resourceTypeId: card.resourceTypeId,
        externalId: card.externalId,
        gridW: card.width ?? 1,
        gridH: card.height ?? 1,
      });
      cards.push(card);
      continue;
    }

    // Widget: put the lifted reference back before validating, so the config is
    // checked by exactly the schema the hand-editing route uses.
    const config: Record<string, unknown> = { ...card.config };
    if (card.widgetKind === "budget") {
      const budgetId = card.budgetKey ? args.budgetIdByKey.get(card.budgetKey) : undefined;
      if (!budgetId) {
        plan.miss(
          "dashboards",
          dashboard.key,
          `budget card names "${card.budgetKey ?? "(none)"}", which is not in this document or this organization`,
        );
        continue;
      }
      config["budgetId"] = budgetId;
    }
    if (card.widgetKind === "custom_graph") {
      const graphId = card.graphKey ? args.graphIdByKey.get(card.graphKey) : undefined;
      if (!graphId) {
        plan.miss(
          "dashboards",
          dashboard.key,
          `custom-graph card names "${card.graphKey ?? "(none)"}", which is not in this document or this organization`,
        );
        continue;
      }
      config["graphId"] = graphId;
    }
    const parsed = widgetConfigSchemaFor(card.widgetKind).safeParse(config);
    if (!parsed.success) {
      throw new OrgConfigError(
        `Dashboard "${dashboard.name}": invalid ${card.widgetKind} card — ${parsed.error.issues[0]?.message ?? "bad config"}`,
      );
    }
    rows.push({
      kind: "widget",
      widgetKind: card.widgetKind,
      title: card.title,
      config: parsed.data,
      gridW: card.width ?? 2,
      gridH: card.height ?? 1,
    });
    cards.push(card);
  }

  return { rows, cards };
}

/** Drop every card of a dashboard, ahead of rewriting the set. */
async function clearCards(
  tx: Tx,
  organizationId: string,
  dashboardId: string,
  now: Date,
): Promise<void> {
  await tx.delete(dashboardPins).where(eq(dashboardPins.dashboardId, dashboardId));
  await tx.delete(dashboardWorkflowPins).where(eq(dashboardWorkflowPins.dashboardId, dashboardId));
  await tx
    .update(dashboardWidgets)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(dashboardWidgets.organizationId, organizationId),
        eq(dashboardWidgets.dashboardId, dashboardId),
        isNull(dashboardWidgets.deletedAt),
      ),
    );
}

/**
 * Write a dashboard's cards in document order — `gridX` is the index in the one
 * sequence all three card tables share.
 */
async function writeCards(
  tx: Tx,
  organizationId: string,
  dashboardId: string,
  rows: CardRow[],
  now: Date,
): Promise<void> {
  for (const [index, row] of rows.entries()) {
    if (row.kind === "workflow") {
      await tx
        .insert(dashboardWorkflowPins)
        .values({
          id: uuidv4(),
          organizationId,
          dashboardId,
          workflowId: row.workflowId,
          gridX: index,
        })
        .onConflictDoNothing();
      continue;
    }
    if (row.kind === "resource") {
      const [resource] = await tx
        .select({ id: resources.id })
        .from(resources)
        .where(
          and(
            eq(resources.organizationId, organizationId),
            eq(resources.accountId, row.accountId),
            eq(resources.pluginId, row.pluginId),
            eq(resources.resourceTypeId, row.resourceTypeId),
            eq(resources.externalId, row.externalId),
            isNull(resources.deletedAt),
          ),
        )
        .limit(1);
      // Not an error: the resource may simply not have been synced yet. The
      // card is skipped and the next apply (after a sync) picks it up.
      if (!resource) continue;
      await tx
        .insert(dashboardPins)
        .values({
          id: uuidv4(),
          dashboardId,
          resourceId: resource.id,
          gridX: index,
          gridY: 0,
          gridW: row.gridW,
          gridH: row.gridH,
        })
        .onConflictDoNothing();
      continue;
    }
    await tx.insert(dashboardWidgets).values({
      id: uuidv4(),
      organizationId,
      dashboardId,
      kind: row.widgetKind,
      title: row.title,
      config: row.config,
      gridX: index,
      gridY: 0,
      gridW: row.gridW,
      gridH: row.gridH,
      createdAt: now,
      updatedAt: now,
    });
  }
}

/* ------------------------------ cost centres ------------------------------- */

interface ResolvedAllocationRule {
  priority: number;
  match: Record<string, string>;
}

function resolveAllocationRules(
  plan: PlanBuilder,
  centreKey: string,
  rules: Array<{ priority: number; match: Record<string, string | undefined> }>,
  state: OrgConfigState,
): ResolvedAllocationRule[] {
  return rules.map((rule) => {
    const match: Record<string, string> = {};
    if (rule.match.tagKey?.trim()) match["tagKey"] = rule.match.tagKey.trim();
    if (match["tagKey"] && rule.match.tagValue?.trim()) {
      match["tagValue"] = rule.match.tagValue.trim();
    }
    if (rule.match.account?.trim()) {
      const accountId = state.accountIdByName.get(rule.match.account.trim().toLowerCase());
      if (accountId) {
        match["accountId"] = accountId;
      } else {
        // Dropping the clause would widen the rule — it would start claiming
        // spend it was never meant to. Say so instead.
        plan.miss(
          "costCentres",
          centreKey,
          `allocation rule names account "${rule.match.account}", which this organization has not connected — the rule's account clause is dropped`,
        );
      }
    }
    if (rule.match.pluginId?.trim()) match["pluginId"] = rule.match.pluginId.trim();
    if (rule.match.service?.trim()) match["service"] = rule.match.service.trim();
    return { priority: rule.priority, match };
  });
}

async function writeAllocationRules(
  tx: Tx,
  organizationId: string,
  costCentreId: string,
  rules: ResolvedAllocationRule[],
): Promise<void> {
  for (const rule of rules) {
    await tx.insert(costAllocationRules).values({
      id: uuidv4(),
      organizationId,
      costCentreId,
      priority: rule.priority,
      match: rule.match,
    });
  }
}

/* ----------------------------- alert settings ------------------------------ */

interface AlertSettingsArgs {
  organizationId: string;
  now: Date;
  state: OrgConfigState;
  incoming: ParsedOrgConfigDocument["alertSettings"];
}

/**
 * The five org-wide notification settings rows.
 *
 * Every one of them carries a claim column (`lastNotifiedAt`,
 * `lastSentWeekStart`, `smsLastPagedAt`) that the poller owns. None of them is
 * exported and none is written here: resetting a cooldown claim from a config
 * apply would let a `git push` re-open a quiet period mid-window and page
 * people twice.
 */
function planAlertSettings(plan: PlanBuilder, args: AlertSettingsArgs): void {
  const { organizationId, now, state, incoming } = args;
  if (!incoming) return;
  const current = state.alertSettings;

  const singleton = (
    key: string,
    name: string,
    next: unknown,
    currentValue: unknown,
    op: Operation,
  ) => {
    if (sameValue(currentValue, next)) {
      plan.record("alertSettings", key, name, "unchanged");
      return;
    }
    plan.record(
      "alertSettings",
      key,
      name,
      "update",
      changedFields(currentValue as object, next as object),
    );
    plan.op(op);
  };

  if (incoming.costAnomaly) {
    const next = normalizeAnomalySettings(incoming.costAnomaly);
    singleton("cost-anomaly", "Cost anomaly detection", next, current.costAnomaly, async (tx) => {
      await tx
        .insert(orgCostAnomalySettings)
        .values({ organizationId, ...next })
        .onConflictDoUpdate({
          target: orgCostAnomalySettings.organizationId,
          set: { ...next, updatedAt: now },
        });
    });
  }

  if (incoming.drift) {
    const drift = incoming.drift;
    const accountIds: string[] = [];
    for (const name of drift.accounts) {
      const id = state.accountIdByName.get(name.toLowerCase());
      if (id) accountIds.push(id);
      else
        plan.miss(
          "alertSettings",
          "drift",
          `drift scope names account "${name}", which this organization has not connected`,
        );
    }
    // An empty scope means "every account", so a scope that resolves to nothing
    // would silently widen alerting from a few accounts to all of them.
    if (drift.accounts.length > 0 && accountIds.length === 0) {
      throw new OrgConfigError(
        "The drift alert scope names only accounts this organization does not have; an empty scope would mean every account. Fix the names or remove the scope.",
      );
    }
    const next = {
      notifyCreated: drift.notifyCreated,
      notifyUpdated: drift.notifyUpdated,
      notifyDeleted: drift.notifyDeleted,
      cooldownMinutes: drift.cooldownMinutes,
      minChanges: drift.minChanges,
      accounts: accountIds.flatMap((id) => {
        const displayName = state.accountNameById.get(id);
        return displayName ? [displayName] : [];
      }),
    };
    singleton("drift", "Resource drift alerts", next, current.drift, async (tx) => {
      await tx
        .insert(orgDriftAlertSettings)
        .values({
          organizationId,
          notifyCreated: drift.notifyCreated,
          notifyUpdated: drift.notifyUpdated,
          notifyDeleted: drift.notifyDeleted,
          cooldownMinutes: drift.cooldownMinutes,
          minChanges: drift.minChanges,
          accountIds,
        })
        .onConflictDoUpdate({
          target: orgDriftAlertSettings.organizationId,
          set: {
            notifyCreated: drift.notifyCreated,
            notifyUpdated: drift.notifyUpdated,
            notifyDeleted: drift.notifyDeleted,
            cooldownMinutes: drift.cooldownMinutes,
            minChanges: drift.minChanges,
            accountIds,
            updatedAt: now,
          },
        });
    });
  }

  if (incoming.expiry) {
    const next = { enabled: incoming.expiry.enabled, leadDays: incoming.expiry.leadDays };
    singleton("expiry", "Expiry alerts", next, current.expiry, async (tx) => {
      await tx
        .insert(orgExpirySettings)
        .values({ organizationId, ...next })
        .onConflictDoUpdate({
          target: orgExpirySettings.organizationId,
          set: { ...next, updatedAt: now },
        });
    });
  }

  if (incoming.posture) {
    const next = { enabled: incoming.posture.enabled };
    singleton("posture", "Posture alerts", next, current.posture, async (tx) => {
      await tx
        .insert(orgPostureSettings)
        .values({ organizationId, ...next })
        .onConflictDoUpdate({
          target: orgPostureSettings.organizationId,
          set: { ...next, updatedAt: now },
        });
    });
  }

  if (incoming.digest) {
    const digest = incoming.digest;
    if (!isValidTimeZone(digest.timezone)) {
      throw new OrgConfigError(`Unknown digest time zone: ${digest.timezone}`);
    }
    let recipients: string[];
    try {
      recipients = [...new Set(digest.recipients.map((email) => normalizeEmailAddress(email)))];
    } catch (e) {
      throw new OrgConfigError(
        `Digest recipients: ${e instanceof Error ? e.message : "invalid email address"}`,
      );
    }
    const next = { ...digest, recipients: recipients.sort() };
    const currentDigest = { ...current.digest, recipients: [...current.digest.recipients].sort() };
    // Enabling marks the current window as already covered, so the first
    // scheduled digest goes out at the next send time rather than the moment a
    // `config apply` lands — the same rule `updateOrgDigestSettings` follows.
    const window = digestWindow(now, digest.timezone);
    singleton("digest", "Weekly digest", next, currentDigest, async (tx) => {
      const values = {
        enabled: digest.enabled,
        timezone: digest.timezone,
        sendDay: digest.sendDay,
        sendHour: digest.sendHour,
        narrativeEnabled: digest.narrativeEnabled,
      };
      await tx
        .insert(orgDigestSettings)
        .values({
          organizationId,
          ...values,
          lastSentWeekStart: digest.enabled ? window.weekStart : null,
        })
        .onConflictDoUpdate({
          target: orgDigestSettings.organizationId,
          set: { ...values, updatedAt: now },
        });
      await tx
        .delete(digestEmailRecipients)
        .where(eq(digestEmailRecipients.organizationId, organizationId));
      for (const email of recipients) {
        await tx
          .insert(digestEmailRecipients)
          .values({ id: uuidv4(), organizationId, email })
          .onConflictDoNothing();
      }
    });
  }
}

/* --------------------------------- entry points ---------------------------- */

/** What an apply would do, without doing any of it. */
export async function planOrgConfig(
  organizationId: string,
  doc: ParsedOrgConfigDocument,
  opts: PlanOrgConfigOptions,
): Promise<OrgConfigPlan> {
  const built = await buildOrgConfigPlan(organizationId, doc, opts);
  return built.plan;
}

/**
 * Apply a document. Returns the plan that was executed — the same shape
 * {@link planOrgConfig} returns, so a caller can show the user exactly what
 * happened in the words it used to preview it.
 */
export async function applyOrgConfig(
  organizationId: string,
  doc: ParsedOrgConfigDocument,
  opts: PlanOrgConfigOptions,
): Promise<OrgConfigApplyResult> {
  const built = await buildOrgConfigPlan(organizationId, doc, opts);
  if (built.touchesCustomGraphs) {
    // Outside the transaction: a plan gate is about billing, not about data
    // consistency, and it must fail before anything is written.
    await requirePaidPlan(organizationId, "Custom graphs");
  }
  if (built.operations.length > 0) {
    await db.transaction(async (tx) => {
      for (const operation of built.operations) await operation(tx);
    });
  }
  return { ...built.plan, applied: true };
}
