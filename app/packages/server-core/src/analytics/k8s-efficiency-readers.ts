/**
 * The one scan behind a Kubernetes efficiency report.
 *
 * Reads the Kubernetes plugin's derived cost rows out of `cost_daily`,
 * aggregated to (bucket, group, cluster, service, resource tag, usage tag,
 * currency). Everything after that (classifying rows written before the tags
 * existed, the category filter, spreading idle money, efficiency) is
 * `buildKubernetesEfficiencyResult` in client-core, so every surface computes
 * the same figures from the same rows.
 *
 * The org predicate comes from `costDailyOrgCondition`, like every other
 * `cost_daily` read, so a caller's cost visibility scope narrows this scan
 * without the report knowing scopes exist.
 */
import {
  K8S_RESOURCE_TAG,
  K8S_USAGE_TAG,
  KUBERNETES_COST_PLUGIN_ID,
  type CostFilter,
  type K8sEfficiencyGranularity,
  type K8sEfficiencyGroupBy,
  type KubernetesEfficiencyScanRow,
} from "@infrawrench/client-core";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";

import { getClickHouseDb, isClickHouseConfigured } from "./client";
import { costDailyOrgCondition } from "./cost-readers";
import { dayRange, membershipCondition, physicalDimensionExpr } from "./cost-sql";
import { costDaily } from "./schema";

export interface KubernetesEfficiencyScan {
  from: string;
  to: string;
  granularity: K8sEfficiencyGranularity;
  filters: CostFilter[];
  groupBy: K8sEfficiencyGroupBy;
  groupByLabelKey?: string | undefined;
}

function bucketExpr(granularity: K8sEfficiencyGranularity): SQL {
  switch (granularity) {
    case "week":
      // Mode 1: weeks start on Monday, matching `kubernetesEfficiencyBucketStart`.
      return sql`toString(toStartOfWeek(${costDaily.day}, 1))`;
    case "month":
      return sql`toString(toStartOfMonth(${costDaily.day}))`;
    case "day":
      return sql`toString(${costDaily.day})`;
  }
}

/**
 * The group-by expression. `""` means "this row has no value for the
 * grouping" (idle capacity has no namespace), which the assembly turns into
 * an idle, overhead or unattributed row. `category` is decided after
 * classification, so the scan does not group by anything for it.
 */
function groupExpr(scan: KubernetesEfficiencyScan): SQL {
  const tag = (key: string) => sql`${costDaily.tags}[${key}]`;
  switch (scan.groupBy) {
    case "cluster":
      return sql`${costDaily.account_id}`;
    case "namespace":
      return tag("namespace");
    case "workload":
      // Namespace-qualified, so two `web` Deployments in different
      // namespaces stay apart. The cluster-capacity buckets have no namespace
      // and so no workload.
      return sql`if(${tag("namespace")} != '' AND ${tag("workload")} != '', concat(${tag("namespace")}, '/', ${tag("workload_kind")}, '/', ${tag("workload")}), '')`;
    case "node_pool":
      return tag("node_pool");
    case "label":
      if (!scan.groupByLabelKey) throw new Error("Grouping by label needs a label key");
      return tag(scan.groupByLabelKey);
    case "category":
      return sql`''`;
  }
}

/** Aggregate the org's Kubernetes cost rows for one report window. */
export async function scanKubernetesEfficiency(
  organizationId: string,
  scan: KubernetesEfficiencyScan,
): Promise<KubernetesEfficiencyScanRow[]> {
  if (!isClickHouseConfigured()) return [];
  const db = getClickHouseDb();
  const where = and(
    costDailyOrgCondition(organizationId),
    dayRange(scan.from, scan.to),
    eq(costDaily.plugin_id, KUBERNETES_COST_PLUGIN_ID),
    ...scan.filters.map((f) =>
      membershipCondition(
        physicalDimensionExpr(f.dimension === "virtual_tag" ? "tag" : f.dimension, f.tagKey),
        f.op,
        f.values,
      ),
    ),
  );
  const rows = await db
    .select({
      bucket: bucketExpr(scan.granularity).as("bucket"),
      grp: groupExpr(scan).as("grp"),
      account_id: costDaily.account_id,
      service: costDaily.service,
      resource: sql<string>`${costDaily.tags}[${K8S_RESOURCE_TAG}]`.as("resource"),
      usage: sql<string>`${costDaily.tags}[${K8S_USAGE_TAG}]`.as("usage"),
      currency: costDaily.currency,
      amount: sql<number>`sum(${costDaily.amount})`.as("amount"),
    })
    .from(costDaily)
    // FINAL, like every spend read: a restated day must never count twice.
    .final()
    .where(where)
    .groupBy(
      sql`bucket`,
      sql`grp`,
      costDaily.account_id,
      costDaily.service,
      sql`resource`,
      sql`usage`,
      costDaily.currency,
    )
    .orderBy(asc(sql`bucket`));

  return rows.map((r) => ({
    bucket: String(r.bucket),
    group: String(r.grp ?? ""),
    accountId: String(r.account_id),
    service: String(r.service),
    resource: String(r.resource ?? ""),
    usage: String(r.usage ?? ""),
    currency: String(r.currency),
    amount: Number(r.amount),
  }));
}

/**
 * Distinct values of one Kubernetes dimension, for the report's pickers.
 * Narrowed to Kubernetes rows (and to the caller's visibility scope), so the
 * namespace picker never offers a value from another provider's tags.
 */
export async function getKubernetesDimensionValues(
  organizationId: string,
  opts: { dimension: "account" | "region" | "tag"; tagKey?: string | undefined },
): Promise<string[]> {
  if (!isClickHouseConfigured()) return [];
  const db = getClickHouseDb();
  const expr = physicalDimensionExpr(opts.dimension, opts.tagKey);
  const rows = await db
    .selectDistinct({ value: expr.as("value") })
    .from(costDaily)
    .where(
      and(
        costDailyOrgCondition(organizationId),
        eq(costDaily.plugin_id, KUBERNETES_COST_PLUGIN_ID),
        sql`${expr} != ''`,
      ),
    )
    .orderBy(asc(sql`value`))
    .limit(500);
  return rows.map((r) => String(r.value));
}

/** Tag keys present on the org's Kubernetes cost rows, for the label pickers. */
export async function getKubernetesTagKeys(organizationId: string): Promise<string[]> {
  if (!isClickHouseConfigured()) return [];
  const db = getClickHouseDb();
  const rows = await db
    .selectDistinct({ key: sql<string>`arrayJoin(mapKeys(${costDaily.tags}))`.as("key") })
    .from(costDaily)
    .where(
      and(
        costDailyOrgCondition(organizationId),
        eq(costDaily.plugin_id, KUBERNETES_COST_PLUGIN_ID),
      ),
    )
    .orderBy(asc(sql`key`))
    .limit(1000);
  return rows.map((r) => String(r.key));
}
