/**
 * Kubernetes efficiency reports: CRUD, execution and the pickers' options.
 * Shared by the HTTP routes (api/routes/k8s-efficiency-reports.ts) and the
 * chat/MCP tools, so both enforce sharing and run the same query.
 *
 * A report is a saved `KubernetesEfficiencyConfig`. Running one scans the
 * Kubernetes plugin's cost rows (`scanKubernetesEfficiency`) under the
 * caller's cost visibility scope, which the request middleware establishes,
 * and assembles the figures with client-core's `buildKubernetesEfficiencyResult`.
 * Nothing computed is stored.
 *
 * Reports are filed in the cost-report folder tree and shared through
 * `object_access_grants` like cost reports: a folder's explicit sharing
 * reaches the reports in it, and the creator is the implicit owner.
 */
import {
  buildKubernetesEfficiencyResult,
  groupCostTagKeys,
  KUBERNETES_COST_PLUGIN_ID,
  resolveKubernetesEfficiencyRange,
  type CostTagKeyDescription,
  type CostTagKeyGroup,
  type KubernetesEfficiencyConfig,
  type KubernetesEfficiencyReport,
  type KubernetesEfficiencyReportInput,
  type KubernetesEfficiencyResult,
  type KubernetesEfficiencyRunResult,
  type ObjectAccessLevel,
} from "@infrawrench/client-core";
import {
  getKubernetesDimensionValues,
  getKubernetesTagKeys,
  scanKubernetesEfficiency,
} from "@infrawrench/server-core/clickhouse/k8s-efficiency-readers";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

import { db } from "../db/client";
import { accounts, kubernetesEfficiencyReports } from "../db/schema";
import { assertCanFileIntoCostReportFolder } from "./cost-report-folders";
import {
  deleteObjectSharing,
  filterVisibleObjects,
  ObjectNotVisibleError,
  requireObjectAccess,
} from "./object-sharing";

type ReportRow = typeof kubernetesEfficiencyReports.$inferSelect;

const OBJECT_TYPE = "kubernetes_efficiency_report" as const;

function toReport(row: ReportRow): KubernetesEfficiencyReport {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    config: row.config as KubernetesEfficiencyConfig,
    folderId: row.folderId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function metaOf(row: ReportRow) {
  return { createdByUserId: row.createdByUserId, folderId: row.folderId };
}

/** The org's reports the caller may open, alphabetically. */
export async function listKubernetesEfficiencyReports(
  organizationId: string,
): Promise<KubernetesEfficiencyReport[]> {
  const rows = await db
    .select()
    .from(kubernetesEfficiencyReports)
    .where(
      and(
        eq(kubernetesEfficiencyReports.organizationId, organizationId),
        isNull(kubernetesEfficiencyReports.deletedAt),
      ),
    )
    .orderBy(asc(kubernetesEfficiencyReports.name));
  const visible = await filterVisibleObjects(
    organizationId,
    OBJECT_TYPE,
    rows,
    (r) => r.id,
    metaOf,
  );
  return visible.map(toReport);
}

async function loadRowUnchecked(
  organizationId: string,
  reportId: string,
): Promise<ReportRow | null> {
  const [row] = await db
    .select()
    .from(kubernetesEfficiencyReports)
    .where(
      and(
        eq(kubernetesEfficiencyReports.id, reportId),
        eq(kubernetesEfficiencyReports.organizationId, organizationId),
        isNull(kubernetesEfficiencyReports.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The row when the caller holds `needed` on it; null when it is not visible. */
async function loadRow(
  organizationId: string,
  reportId: string,
  needed: ObjectAccessLevel | "delete" = "viewer",
): Promise<ReportRow | null> {
  const row = await loadRowUnchecked(organizationId, reportId);
  if (!row) return null;
  try {
    await requireObjectAccess(organizationId, OBJECT_TYPE, row.id, metaOf(row), needed);
  } catch (e) {
    // Below viewer reads as "no such report", exactly like a deleted one.
    if (e instanceof ObjectNotVisibleError) return null;
    throw e;
  }
  return row;
}

export async function getKubernetesEfficiencyReport(
  organizationId: string,
  reportId: string,
): Promise<KubernetesEfficiencyReport | null> {
  const row = await loadRow(organizationId, reportId);
  return row ? toReport(row) : null;
}

export async function createKubernetesEfficiencyReport(
  organizationId: string,
  input: KubernetesEfficiencyReportInput,
  createdByUserId: string | null,
): Promise<KubernetesEfficiencyReport> {
  // A stale or cross-org folder is a CostReportFolderError (400), a folder the
  // caller only views a 403, exactly as for a cost report.
  if (input.folderId) await assertCanFileIntoCostReportFolder(organizationId, input.folderId);
  const [created] = await db
    .insert(kubernetesEfficiencyReports)
    .values({
      id: uuidv4(),
      organizationId,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      config: input.config,
      folderId: input.folderId ?? null,
      createdByUserId,
    })
    .returning();
  return toReport(created!);
}

/** Full replace, like cost reports. Null when not found or not visible. */
export async function updateKubernetesEfficiencyReport(
  organizationId: string,
  reportId: string,
  input: KubernetesEfficiencyReportInput,
): Promise<KubernetesEfficiencyReport | null> {
  const current = await loadRow(organizationId, reportId, "editor");
  if (!current) return null;
  // Only a move is checked: re-saving where it already sits must not fail for
  // an editor of the report who merely views its folder.
  if (input.folderId && input.folderId !== current.folderId) {
    await assertCanFileIntoCostReportFolder(organizationId, input.folderId);
  }
  const [updated] = await db
    .update(kubernetesEfficiencyReports)
    .set({
      name: input.name.trim(),
      description: input.description?.trim() || null,
      config: input.config,
      folderId: input.folderId ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(kubernetesEfficiencyReports.id, reportId),
        eq(kubernetesEfficiencyReports.organizationId, organizationId),
        isNull(kubernetesEfficiencyReports.deletedAt),
      ),
    )
    .returning();
  return updated ? toReport(updated) : null;
}

/** Soft delete. False when not found or not the caller's to delete. */
export async function softDeleteKubernetesEfficiencyReport(
  organizationId: string,
  reportId: string,
): Promise<boolean> {
  if (!(await loadRow(organizationId, reportId, "delete"))) return false;
  const now = new Date();
  const [deleted] = await db
    .update(kubernetesEfficiencyReports)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(kubernetesEfficiencyReports.id, reportId),
        eq(kubernetesEfficiencyReports.organizationId, organizationId),
        isNull(kubernetesEfficiencyReports.deletedAt),
      ),
    )
    .returning({ id: kubernetesEfficiencyReports.id });
  if (!deleted) return false;
  await deleteObjectSharing(organizationId, OBJECT_TYPE, reportId);
  return true;
}

/** Display names of the org's Kubernetes clusters, by account id. */
async function clusterNames(
  organizationId: string,
  ids?: readonly string[],
): Promise<Record<string, string>> {
  if (ids && ids.length === 0) return {};
  const rows = await db
    .select({ id: accounts.id, name: accounts.displayName })
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, organizationId),
        eq(accounts.pluginId, KUBERNETES_COST_PLUGIN_ID),
        ids ? inArray(accounts.id, [...ids]) : undefined,
      ),
    );
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

/**
 * Run a config. The caller's cost visibility scope is already ambient (the
 * request middleware, `runToolHandler`), so the scan only ever sees rows the
 * caller may see.
 */
export async function queryKubernetesEfficiency(
  organizationId: string,
  config: KubernetesEfficiencyConfig,
  today = new Date(),
): Promise<KubernetesEfficiencyResult> {
  const { from, to } = resolveKubernetesEfficiencyRange(config, today);
  const scan = await scanKubernetesEfficiency(organizationId, {
    from,
    to,
    granularity: config.granularity,
    filters: config.filters,
    groupBy: config.groupBy,
    groupByLabelKey: config.groupByLabelKey,
  });
  const labels =
    config.groupBy === "cluster"
      ? await clusterNames(organizationId, [...new Set(scan.map((r) => r.group))])
      : undefined;
  return buildKubernetesEfficiencyResult(scan, { config, from, to, labels });
}

/** Run a saved report by id. Null when not found or not visible. */
export async function runKubernetesEfficiencyReport(
  organizationId: string,
  reportId: string,
  today = new Date(),
): Promise<KubernetesEfficiencyRunResult | null> {
  const row = await loadRow(organizationId, reportId);
  if (!row) return null;
  return {
    reportId: row.id,
    name: row.name,
    result: await queryKubernetesEfficiency(
      organizationId,
      row.config as KubernetesEfficiencyConfig,
      today,
    ),
  };
}

/** What the editor's pickers offer, all read from the real rows. */
export interface KubernetesEfficiencyOptions {
  clusters: Array<{ id: string; name: string }>;
  regions: string[];
  namespaces: string[];
  nodePools: string[];
  /** Tag keys on Kubernetes rows, grouped like every other tag picker. */
  labelKeys: Array<{ group: CostTagKeyGroup; keys: CostTagKeyDescription[] }>;
}

/** Tags the report reads itself; never offered as a label to group or filter by. */
const INTERNAL_TAG_KEYS = new Set(["k8s_resource", "k8s_usage", "system"]);

export async function getKubernetesEfficiencyOptions(
  organizationId: string,
): Promise<KubernetesEfficiencyOptions> {
  const [names, regions, namespaces, nodePools, tagKeys] = await Promise.all([
    clusterNames(organizationId),
    getKubernetesDimensionValues(organizationId, { dimension: "region" }),
    getKubernetesDimensionValues(organizationId, { dimension: "tag", tagKey: "namespace" }),
    getKubernetesDimensionValues(organizationId, { dimension: "tag", tagKey: "node_pool" }),
    getKubernetesTagKeys(organizationId),
  ]);
  return {
    clusters: Object.entries(names)
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    regions,
    namespaces,
    nodePools,
    labelKeys: groupCostTagKeys(tagKeys.filter((k) => !INTERNAL_TAG_KEYS.has(k))),
  };
}

/** Distinct values of one tag key on Kubernetes rows (the value picker). */
export async function getKubernetesEfficiencyTagValues(
  organizationId: string,
  tagKey: string,
): Promise<string[]> {
  return getKubernetesDimensionValues(organizationId, { dimension: "tag", tagKey });
}
