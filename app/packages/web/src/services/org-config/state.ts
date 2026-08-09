/**
 * The org's current configuration, read once and shaped exactly like the
 * exported document.
 *
 * Both directions go through here. Export serialises this straight out; apply
 * diffs the incoming document against it. That is deliberate — a round trip is
 * only lossless if "what we have" and "what a document says" are the same
 * shape, computed by the same code.
 *
 * **Key derivation.** The tables have no key column, so a row's key is derived
 * from its name (`uniqueOrgConfigKey`) over a *stable* ordering — created-at,
 * then id. Not the ordering the list endpoints use: `listWorkflows` sorts by
 * `updatedAt`, so deriving keys from that would rename every key whenever
 * someone saved a workflow, and the next apply would delete-and-recreate the
 * lot. Created-at never moves.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { DASHBOARD_WIDGET_KINDS } from "@infrawrench/client-core";
import type {
  CostFilter,
  DashboardWidgetKind,
  OrgConfigAlertSettingsResolved,
  OrgConfigBudget,
  OrgConfigCostCentre,
  OrgConfigCustomGraph,
  OrgConfigDashboard,
  OrgConfigDashboardCard,
  OrgConfigMetricAlert,
  OrgConfigProbe,
  OrgConfigWorkflow,
  OrgConfigWorkflowMetric,
  OrgConfigWorkflowTrigger,
  TagPolicy,
} from "@infrawrench/client-core";
import { uniqueOrgConfigKey } from "@infrawrench/client-core";
import { getOrgTagPolicy } from "@infrawrench/server-core/cost/tag-policy";
import { getOrgAnomalySettings } from "@infrawrench/server-core/cost/anomaly-settings";
import { getDriftAlertSettings } from "@infrawrench/server-core/drift/settings";
import { getExpirySettings } from "@infrawrench/server-core/expiry/settings";
import { getPostureSettings } from "@infrawrench/server-core/posture/settings";
import { getOrgDigestSettings } from "@infrawrench/server-core/digest/weekly";
import { listDigestEmailRecipients } from "@infrawrench/server-core/digest/recipients";
import { db } from "../../db/client";
import {
  accounts,
  budgets,
  costAllocationRules,
  costCentres,
  customGraphs,
  dashboardPins,
  dashboardWidgets,
  dashboardWorkflowPins,
  dashboards,
  metricAlertRules,
  resources,
  syntheticProbes,
  workflows,
} from "../../db/schema";

/** One existing row, paired with the document key it round-trips under. */
export interface OrgConfigEntity<T> {
  key: string;
  /** The database id. Never appears in the document. */
  id: string;
  /** The row rendered in document shape — what a diff compares against. */
  config: T;
}

/**
 * Stable identity for a live resource pin, used both to decide at plan time
 * whether a dashboard resource card can resolve and (defensively) at write time.
 * `externalId` is the empty string when the inventory row has none.
 */
export function orgConfigResourceKey(
  accountId: string,
  pluginId: string,
  resourceTypeId: string,
  externalId: string,
): string {
  return `${accountId}\0${pluginId}\0${resourceTypeId}\0${externalId}`;
}

export interface OrgConfigState {
  /** Account id → display name, for rendering ids the document must not carry. */
  accountNameById: Map<string, string>;
  /** Lower-cased display name → account id. First match wins on a duplicate name. */
  accountIdByName: Map<string, string>;
  /**
   * Live (non-deleted) resources keyed by {@link orgConfigResourceKey}. Planning
   * uses this so a resource pin that has not been synced yet is reported as
   * unresolved instead of accepted and then silently skipped on apply.
   */
  resourceKeys: Set<string>;
  budgets: OrgConfigEntity<OrgConfigBudget>[];
  customGraphs: OrgConfigEntity<OrgConfigCustomGraph>[];
  workflows: OrgConfigEntity<OrgConfigWorkflow>[];
  dashboards: OrgConfigEntity<OrgConfigDashboard>[];
  metricAlerts: OrgConfigEntity<OrgConfigMetricAlert>[];
  probes: OrgConfigEntity<OrgConfigProbe>[];
  costCentres: OrgConfigEntity<OrgConfigCostCentre>[];
  tagPolicy: TagPolicy;
  alertSettings: OrgConfigAlertSettingsResolved;
}

/** Assign document keys across a collection, in the order given. */
function withKeys<Row, T extends { key: string }>(
  rows: Row[],
  id: (row: Row) => string,
  name: (row: Row) => string,
  build: (row: Row, key: string) => T,
): OrgConfigEntity<T>[] {
  const taken = new Set<string>();
  return rows.map((row) => {
    const key = uniqueOrgConfigKey(name(row), taken);
    return { key, id: id(row), config: build(row, key) };
  });
}

/** Null and empty strings both mean "absent" in the document. */
function optionalText(value: string | null): string | null | undefined {
  return value ?? null;
}

export async function loadOrgConfigState(organizationId: string): Promise<OrgConfigState> {
  const [
    accountRows,
    budgetRows,
    graphRows,
    workflowRows,
    dashboardRows,
    alertRows,
    probeRows,
    centreRows,
    allocationRows,
    resourceRows,
  ] = await Promise.all([
    db
      .select({ id: accounts.id, displayName: accounts.displayName })
      .from(accounts)
      .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt)))
      .orderBy(asc(accounts.createdAt), asc(accounts.id)),
    db
      .select()
      .from(budgets)
      .where(and(eq(budgets.organizationId, organizationId), isNull(budgets.deletedAt)))
      .orderBy(asc(budgets.createdAt), asc(budgets.id)),
    db
      .select()
      .from(customGraphs)
      .where(and(eq(customGraphs.organizationId, organizationId), isNull(customGraphs.deletedAt)))
      .orderBy(asc(customGraphs.createdAt), asc(customGraphs.id)),
    db
      .select()
      .from(workflows)
      .where(and(eq(workflows.organizationId, organizationId), isNull(workflows.deletedAt)))
      .orderBy(asc(workflows.createdAt), asc(workflows.id)),
    db
      .select()
      .from(dashboards)
      .where(and(eq(dashboards.organizationId, organizationId), isNull(dashboards.deletedAt)))
      .orderBy(asc(dashboards.createdAt), asc(dashboards.id)),
    db
      .select()
      .from(metricAlertRules)
      .where(
        and(
          eq(metricAlertRules.organizationId, organizationId),
          isNull(metricAlertRules.deletedAt),
        ),
      )
      .orderBy(asc(metricAlertRules.createdAt), asc(metricAlertRules.id)),
    db
      .select()
      .from(syntheticProbes)
      .where(eq(syntheticProbes.organizationId, organizationId))
      .orderBy(asc(syntheticProbes.createdAt), asc(syntheticProbes.id)),
    db
      .select()
      .from(costCentres)
      .where(eq(costCentres.organizationId, organizationId))
      .orderBy(asc(costCentres.createdAt), asc(costCentres.id)),
    db
      .select()
      .from(costAllocationRules)
      .where(eq(costAllocationRules.organizationId, organizationId))
      .orderBy(asc(costAllocationRules.priority), asc(costAllocationRules.id)),
    // Identity columns only — used to resolve dashboard resource pins at plan
    // time so apply never reports a card as written when the inventory has not
    // synced it yet.
    db
      .select({
        accountId: resources.accountId,
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
        externalId: resources.externalId,
      })
      .from(resources)
      .where(and(eq(resources.organizationId, organizationId), isNull(resources.deletedAt))),
  ]);

  const accountNameById = new Map(accountRows.map((a) => [a.id, a.displayName]));
  const accountIdByName = new Map<string, string>();
  for (const account of accountRows) {
    const lower = account.displayName.toLowerCase();
    if (!accountIdByName.has(lower)) accountIdByName.set(lower, account.id);
  }

  const resourceKeys = new Set(
    resourceRows.map((r) =>
      orgConfigResourceKey(r.accountId, r.pluginId, r.resourceTypeId, r.externalId ?? ""),
    ),
  );

  const budgetEntities = withKeys(
    budgetRows,
    (b) => b.id,
    (b) => b.name,
    (b, key) => ({
      key,
      name: b.name,
      amountCents: b.amountCents,
      currency: b.currency,
      filters: (b.filters ?? []) as CostFilter[],
      thresholds: (b.thresholds ?? []) as OrgConfigBudget["thresholds"],
    }),
  );
  const budgetKeyById = new Map(budgetEntities.map((b) => [b.id, b.key]));

  const graphEntities = withKeys(
    graphRows,
    (g) => g.id,
    (g) => g.name,
    (g, key) => ({
      key,
      name: g.name,
      description: optionalText(g.description),
      source: g.source,
    }),
  );
  const graphKeyById = new Map(graphEntities.map((g) => [g.id, g.key]));

  const workflowEntities = withKeys(
    workflowRows,
    (w) => w.id,
    (w) => w.name,
    (w, key) => ({
      key,
      name: w.name,
      description: optionalText(w.description),
      source: w.source,
      trigger: exportTrigger(w.trigger, budgetKeyById),
      metrics: exportMetrics(w.metricDefs),
      enabled: w.enabled,
    }),
  );
  const workflowKeyById = new Map(workflowEntities.map((w) => [w.id, w.key]));

  const dashboardCards = await loadDashboardCards(
    organizationId,
    dashboardRows.map((d) => d.id),
    { budgetKeyById, graphKeyById, workflowKeyById, accountNameById },
  );

  const dashboardEntities = withKeys(
    dashboardRows,
    (d) => d.id,
    (d) => d.name,
    (d, key) => ({
      key,
      name: d.name,
      isDefault: d.isDefault,
      cards: dashboardCards.get(d.id) ?? [],
    }),
  );

  const alertEntities = withKeys(
    alertRows,
    (r) => r.id,
    (r) => r.name,
    (r, key) => ({
      key,
      name: r.name,
      pluginId: r.pluginId,
      resourceTypeId: r.resourceTypeId,
      tagKey: r.tagKey,
      tagValue: r.tagValue,
      metricKey: r.metricKey,
      comparator: r.comparator,
      threshold: r.threshold,
      forMinutes: r.forMinutes,
      cooldownMinutes: r.cooldownMinutes,
      enabled: r.enabled,
    }),
  );

  const probeEntities = withKeys(
    probeRows,
    (p) => p.id,
    (p) => p.name,
    (p, key) => ({
      key,
      name: p.name,
      url: p.url,
      method: p.method,
      intervalSeconds: p.intervalSeconds,
      timeoutMs: p.timeoutMs,
      failureThreshold: p.failureThreshold,
      enabled: p.enabled,
    }),
  );

  const centreEntities = withKeys(
    centreRows,
    (c) => c.id,
    (c) => c.name,
    (c, key) => ({
      key,
      name: c.name,
      description: optionalText(c.description),
      rules: allocationRows
        .filter((r) => r.costCentreId === c.id)
        .map((r) => ({
          priority: r.priority,
          match: {
            ...(r.match?.tagKey ? { tagKey: r.match.tagKey } : {}),
            ...(r.match?.tagKey && r.match?.tagValue ? { tagValue: r.match.tagValue } : {}),
            // The document names accounts, never ids. A rule bound to an
            // account that has since been removed loses its account clause
            // rather than exporting a dangling id.
            ...(r.match?.accountId && accountNameById.has(r.match.accountId)
              ? { account: accountNameById.get(r.match.accountId)! }
              : {}),
            ...(r.match?.pluginId ? { pluginId: r.match.pluginId } : {}),
            ...(r.match?.service ? { service: r.match.service } : {}),
          },
        })),
    }),
  );

  const [tagPolicy, costAnomaly, drift, expiry, posture, digest, recipients] = await Promise.all([
    getOrgTagPolicy(organizationId),
    getOrgAnomalySettings(organizationId),
    getDriftAlertSettings(organizationId),
    getExpirySettings(organizationId),
    getPostureSettings(organizationId),
    getOrgDigestSettings(organizationId),
    listDigestEmailRecipients(organizationId),
  ]);

  return {
    accountNameById,
    accountIdByName,
    resourceKeys,
    budgets: budgetEntities,
    customGraphs: graphEntities,
    workflows: workflowEntities,
    dashboards: dashboardEntities,
    metricAlerts: alertEntities,
    probes: probeEntities,
    costCentres: centreEntities,
    tagPolicy,
    alertSettings: {
      costAnomaly: {
        sigmas: costAnomaly.sigmas,
        minDeltaCents: costAnomaly.minDeltaCents,
        newSourceMinCents: costAnomaly.newSourceMinCents,
        smsAlerts: costAnomaly.smsAlerts,
      },
      drift: {
        notifyCreated: drift.notifyCreated,
        notifyUpdated: drift.notifyUpdated,
        notifyDeleted: drift.notifyDeleted,
        cooldownMinutes: drift.cooldownMinutes,
        minChanges: drift.minChanges,
        accounts: drift.accountIds.flatMap((id) => {
          const displayName = accountNameById.get(id);
          return displayName ? [displayName] : [];
        }),
      },
      expiry: { enabled: expiry.enabled, leadDays: expiry.leadDays },
      posture: { enabled: posture.enabled },
      digest: {
        enabled: digest.enabled,
        timezone: digest.timezone,
        sendDay: digest.sendDay,
        sendHour: digest.sendHour,
        narrativeEnabled: digest.narrativeEnabled,
        recipients: recipients.map((r) => r.email),
      },
    },
  };
}

/** Stored trigger jsonb → document trigger (budget id rewritten to its key). */
function exportTrigger(raw: unknown, budgetKeyById: Map<string, string>): OrgConfigWorkflowTrigger {
  const trigger = (raw ?? {}) as Record<string, unknown>;
  switch (trigger["kind"]) {
    case "cron":
      return {
        kind: "cron",
        expression: String(trigger["expression"] ?? ""),
        ...(typeof trigger["timezone"] === "string" ? { timezone: trigger["timezone"] } : {}),
      };
    case "git":
      return {
        kind: "git",
        ...(typeof trigger["provider"] === "string" ? { provider: trigger["provider"] } : {}),
        ...(typeof trigger["repo"] === "string" ? { repo: trigger["repo"] } : {}),
        ...(typeof trigger["branch"] === "string" ? { branch: trigger["branch"] } : {}),
        ...(Array.isArray(trigger["events"])
          ? { events: trigger["events"].filter((e): e is string => typeof e === "string") }
          : {}),
        ...(typeof trigger["installationId"] === "number"
          ? { installationId: trigger["installationId"] }
          : {}),
      };
    case "budget": {
      // A trigger whose budget is gone can never fire again; exporting it as
      // manual is the honest reading, and it keeps the document self-consistent
      // (every `budgetKey` in a document resolves within that document).
      const budgetKey = budgetKeyById.get(String(trigger["budgetId"] ?? ""));
      if (!budgetKey) return { kind: "manual" };
      return {
        kind: "budget",
        budgetKey,
        ...(typeof trigger["percent"] === "number" ? { percent: trigger["percent"] } : {}),
        ...(trigger["metric"] === "actual" || trigger["metric"] === "forecast"
          ? { metric: trigger["metric"] }
          : {}),
      };
    }
    default:
      return { kind: "manual" };
  }
}

function exportMetrics(raw: unknown): OrgConfigWorkflowMetric[] {
  if (!Array.isArray(raw)) return [];
  const out: OrgConfigWorkflowMetric[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const def = entry as Record<string, unknown>;
    if (typeof def["key"] !== "string" || !def["key"]) continue;
    out.push({
      key: def["key"],
      label: typeof def["label"] === "string" && def["label"] ? def["label"] : def["key"],
      ...(typeof def["unit"] === "string" ? { unit: def["unit"] } : {}),
      ...(typeof def["type"] === "string" ? { type: def["type"] } : {}),
    });
  }
  return out;
}

interface CardMaps {
  budgetKeyById: Map<string, string>;
  graphKeyById: Map<string, string>;
  workflowKeyById: Map<string, string>;
  accountNameById: Map<string, string>;
}

/**
 * The card list of every dashboard, in grid order.
 *
 * Resource pins, workflow pins and widgets share one `gridX` sequence (see
 * `api/routes/dashboards.ts`), so they are merged and re-sorted into the single
 * ordered `cards` array the document carries — which is also what makes the
 * order reviewable in a diff instead of hidden in integer columns.
 */
async function loadDashboardCards(
  organizationId: string,
  dashboardIds: string[],
  maps: CardMaps,
): Promise<Map<string, OrgConfigDashboardCard[]>> {
  const byDashboard = new Map<
    string,
    Array<{ gridX: number; seq: number; card: OrgConfigDashboardCard }>
  >();
  if (dashboardIds.length === 0) return new Map();

  const [pinRows, workflowPinRows, widgetRows] = await Promise.all([
    db
      .select({
        dashboardId: dashboardPins.dashboardId,
        gridX: dashboardPins.gridX,
        gridW: dashboardPins.gridW,
        gridH: dashboardPins.gridH,
        createdAt: dashboardPins.createdAt,
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
        externalId: resources.externalId,
        accountId: resources.accountId,
      })
      .from(dashboardPins)
      .innerJoin(dashboards, eq(dashboardPins.dashboardId, dashboards.id))
      .innerJoin(resources, eq(dashboardPins.resourceId, resources.id))
      .where(
        and(
          eq(dashboards.organizationId, organizationId),
          isNull(dashboardPins.deletedAt),
          isNull(resources.deletedAt),
        ),
      )
      .orderBy(asc(dashboardPins.gridX), asc(dashboardPins.createdAt)),
    db
      .select({
        dashboardId: dashboardWorkflowPins.dashboardId,
        gridX: dashboardWorkflowPins.gridX,
        createdAt: dashboardWorkflowPins.createdAt,
        workflowId: dashboardWorkflowPins.workflowId,
      })
      .from(dashboardWorkflowPins)
      .where(
        and(
          eq(dashboardWorkflowPins.organizationId, organizationId),
          isNull(dashboardWorkflowPins.deletedAt),
        ),
      )
      .orderBy(asc(dashboardWorkflowPins.gridX), asc(dashboardWorkflowPins.createdAt)),
    db
      .select()
      .from(dashboardWidgets)
      .where(
        and(
          eq(dashboardWidgets.organizationId, organizationId),
          isNull(dashboardWidgets.deletedAt),
        ),
      )
      .orderBy(asc(dashboardWidgets.gridX), asc(dashboardWidgets.createdAt)),
  ]);

  const push = (
    dashboardId: string,
    gridX: number,
    createdAt: Date,
    card: OrgConfigDashboardCard,
  ) => {
    const list = byDashboard.get(dashboardId) ?? [];
    list.push({ gridX, seq: createdAt.getTime(), card });
    byDashboard.set(dashboardId, list);
  };

  for (const pin of pinRows) {
    // A resource with no external id cannot be found again in another org (or
    // after a resync), so pinning it is not expressible as config.
    if (!pin.externalId) continue;
    const account = maps.accountNameById.get(pin.accountId);
    if (!account) continue;
    push(pin.dashboardId, pin.gridX, pin.createdAt, {
      kind: "resource",
      pluginId: pin.pluginId,
      resourceTypeId: pin.resourceTypeId,
      externalId: pin.externalId,
      account,
      ...(pin.gridW !== 1 ? { width: pin.gridW } : {}),
      ...(pin.gridH !== 1 ? { height: pin.gridH } : {}),
    });
  }

  for (const pin of workflowPinRows) {
    const workflowKey = maps.workflowKeyById.get(pin.workflowId);
    if (!workflowKey) continue;
    push(pin.dashboardId, pin.gridX, pin.createdAt, { kind: "workflow", workflowKey });
  }

  for (const widget of widgetRows) {
    // A row written by a newer deployment could name a kind this build has no
    // schema for; exporting it would produce a document that cannot be applied.
    if (!(DASHBOARD_WIDGET_KINDS as readonly string[]).includes(widget.kind)) continue;
    const widgetKind = widget.kind as DashboardWidgetKind;
    const config = { ...((widget.config ?? {}) as Record<string, unknown>) };
    let budgetKey: string | undefined;
    let graphKey: string | undefined;
    if (widgetKind === "budget") {
      budgetKey = maps.budgetKeyById.get(String(config["budgetId"] ?? ""));
      // A card whose target is gone renders as "unavailable" and cannot be
      // recreated anywhere — leave it out rather than export a broken card.
      if (!budgetKey) continue;
      delete config["budgetId"];
    }
    if (widgetKind === "custom_graph") {
      graphKey = maps.graphKeyById.get(String(config["graphId"] ?? ""));
      if (!graphKey) continue;
      delete config["graphId"];
    }
    push(widget.dashboardId, widget.gridX, widget.createdAt, {
      kind: "widget",
      widgetKind,
      title: widget.title,
      config,
      ...(budgetKey ? { budgetKey } : {}),
      ...(graphKey ? { graphKey } : {}),
      ...(widget.gridW !== 2 ? { width: widget.gridW } : {}),
      ...(widget.gridH !== 1 ? { height: widget.gridH } : {}),
    });
  }

  const out = new Map<string, OrgConfigDashboardCard[]>();
  for (const [dashboardId, entries] of byDashboard) {
    entries.sort((a, b) => a.gridX - b.gridX || a.seq - b.seq);
    out.set(
      dashboardId,
      entries.map((e) => e.card),
    );
  }
  return out;
}
