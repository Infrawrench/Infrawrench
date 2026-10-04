/**
 * The read model behind Kubernetes network costs: one cluster's traffic, by
 * namespace, workload and boundary, with the cluster's **billed** data
 * transfer apportioned across it when the user has said which billed rows
 * those are.
 *
 * Two kinds of money appear and they are never confused:
 *
 * - **Estimated**: bytes × the published rate for the boundary they crossed,
 *   exactly as the org-wide network costs screen prices a VPC flow. Always
 *   present, always labelled as list price.
 * - **Allocated**: the cluster's real billed data-transfer spend (a cost query
 *   over `cost_daily`, chosen per cluster) handed out in proportion to the
 *   estimate, day by day, never more than was billed. What is left is an
 *   explicit unallocated remainder, never spread across the workloads.
 *
 * Neither is written anywhere. The rows this reads re-cut traffic the cloud
 * account already bills for, so writing them to `cost_daily` would count the
 * same bytes twice in every budget and invoice; the allocation is computed on
 * read, the same way billing rules are.
 */
import {
  apportionBilledDay,
  CostQueryParseError,
  parseCostQuery,
  type CostFilter,
  type KubernetesNetworkMethod,
  type KubernetesNetworkReport,
  type KubernetesNetworkRow,
  type KubernetesNetworkScopeRow,
  type KubernetesNetworkSettings,
} from "@infrawrench/client-core";
import { NETWORK_FLOW_METHODS, type NetworkFlowScope } from "@infrawrench/plugin-base";
import { and, eq, isNull } from "drizzle-orm";

import { queryCosts } from "../clickhouse/cost-readers";
import {
  readNetworkFlowSourceDays,
  readTopNetworkFlows,
  type NetworkFlowSourceDayRow,
} from "../clickhouse/network-flow-readers";
import { db } from "../db/client";
import { accounts, kubernetesNetworkSettings } from "../db/schema";
import { getPlugin } from "../plugin-loader";

import { TRUNCATED_REF } from "./aggregate";
import { loadAccountStatuses, toPairView } from "./feed";

export class KubernetesNetworkError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "KubernetesNetworkError";
  }
}

/** The longest billed query accepted; the cost query language's own cap. */
const MAX_QUERY_LENGTH = 4000;

/**
 * The account, checked to belong to the org and to a plugin whose flows are a
 * re-cut (`networkFlows.recut`): the only accounts this report means anything
 * for. Throws a 404 rather than revealing whether the id exists elsewhere.
 */
async function loadClusterAccount(
  organizationId: string,
  accountId: string,
): Promise<{ id: string; displayName: string; pluginId: string }> {
  const [account] = await db
    .select({ id: accounts.id, displayName: accounts.displayName, pluginId: accounts.pluginId })
    .from(accounts)
    .where(
      and(
        eq(accounts.id, accountId),
        eq(accounts.organizationId, organizationId),
        isNull(accounts.deletedAt),
      ),
    )
    .limit(1);
  if (!account) throw new KubernetesNetworkError("Account not found", 404);
  const loaded = await getPlugin(account.pluginId);
  if (loaded?.plugin.manifest.networkFlows?.recut !== true) {
    throw new KubernetesNetworkError(
      "This account does not report pod-level network traffic. Pick a Kubernetes account.",
      404,
    );
  }
  return account;
}

export async function getKubernetesNetworkSettings(
  organizationId: string,
  accountId: string,
): Promise<KubernetesNetworkSettings> {
  await loadClusterAccount(organizationId, accountId);
  const [row] = await db
    .select()
    .from(kubernetesNetworkSettings)
    .where(
      and(
        eq(kubernetesNetworkSettings.accountId, accountId),
        eq(kubernetesNetworkSettings.organizationId, organizationId),
      ),
    )
    .limit(1);
  return {
    accountId,
    billedQuery: row?.billedQuery ?? null,
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

/** Compile a billed query, or throw a 400 naming what is wrong with it. */
export function compileBilledQuery(query: string): CostFilter[] {
  try {
    return parseCostQuery(query);
  } catch (e) {
    if (e instanceof CostQueryParseError) throw new KubernetesNetworkError(e.message);
    throw e;
  }
}

/**
 * Save the billed source. An empty or whitespace query clears it. A query that
 * selects nothing at all (no filters) is refused: it would apportion the org's
 * *entire* bill across one cluster's pods, which is never what anyone meant.
 */
export async function setKubernetesNetworkSettings(
  organizationId: string,
  accountId: string,
  input: { billedQuery: string | null },
  updatedByUserId?: string,
): Promise<KubernetesNetworkSettings> {
  await loadClusterAccount(organizationId, accountId);
  const trimmed = (input.billedQuery ?? "").trim();
  if (trimmed.length > MAX_QUERY_LENGTH) {
    throw new KubernetesNetworkError(`billedQuery must be at most ${MAX_QUERY_LENGTH} characters`);
  }
  if (trimmed) {
    const filters = compileBilledQuery(trimmed);
    if (filters.length === 0) {
      throw new KubernetesNetworkError(
        "billedQuery must narrow the spend (for example by account and service); an empty query would apportion the whole bill",
      );
    }
  }
  const billedQuery = trimmed || null;
  const now = new Date();
  await db
    .insert(kubernetesNetworkSettings)
    .values({
      accountId,
      organizationId,
      billedQuery,
      updatedByUserId: updatedByUserId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: kubernetesNetworkSettings.accountId,
      set: { billedQuery, updatedByUserId: updatedByUserId ?? null, updatedAt: now },
    });
  return { accountId, billedQuery, updatedAt: now.toISOString() };
}

/** Where a stored source ref belongs in the report. */
function classifyRef(
  ref: string,
  label: string,
): Pick<KubernetesNetworkRow, "kind" | "namespace" | "label"> {
  if (ref === TRUNCATED_REF) {
    return { kind: "truncated", namespace: "", label: "Flows outside the stored top pairs" };
  }
  if (ref.startsWith("k8s:node/")) return { kind: "node", namespace: "", label: label || ref };
  const parts = ref.split("/");
  if (parts.length >= 3) {
    return { kind: "workload", namespace: parts[0]!, label: label || `${parts[0]}/${parts[2]}` };
  }
  return { kind: "workload", namespace: "", label: label || ref };
}

function weaker(a: KubernetesNetworkMethod, b: string): KubernetesNetworkMethod {
  if (!b) return a;
  if (!a) return b as KubernetesNetworkMethod;
  const rank = (m: string) => NETWORK_FLOW_METHODS.indexOf(m as never);
  return (rank(a) >= rank(b) ? a : b) as KubernetesNetworkMethod;
}

export interface KubernetesNetworkReportOptions {
  from: string;
  to: string;
  limit?: number;
}

/**
 * Build the report. Pure arithmetic over two reads (the cluster's stored rows
 * per day, the billed source per day) plus the top-pairs list.
 */
export async function getKubernetesNetworkReport(
  organizationId: string,
  accountId: string,
  options: KubernetesNetworkReportOptions,
): Promise<KubernetesNetworkReport> {
  const account = await loadClusterAccount(organizationId, accountId);
  const range = { from: options.from, to: options.to };
  const [settings, dayRows, pairs, statuses] = await Promise.all([
    getKubernetesNetworkSettings(organizationId, accountId),
    readNetworkFlowSourceDays(organizationId, accountId, range),
    readTopNetworkFlows(organizationId, range, { accountId }, options.limit ?? 25),
    loadAccountStatuses(organizationId),
  ]);
  const currency = dayRows.find((r) => r.currency)?.currency || "USD";

  // The billed source, per day, in the rows' currency.
  let billedError: string | null = null;
  let billedByDay: Map<string, number> | null = null;
  if (settings.billedQuery) {
    try {
      const filters = compileBilledQuery(settings.billedQuery);
      const groups = await queryCosts(organizationId, {
        from: range.from,
        to: range.to,
        binning: "daily",
        groupBy: "none",
        filters,
      });
      const matching = groups.filter((g) => g.currency === currency);
      if (groups.length > 0 && matching.length === 0) {
        billedError =
          `The billed rows are in ${groups.map((g) => g.currency).join(", ")} but the traffic ` +
          `is priced in ${currency}; nothing was apportioned rather than mixing currencies.`;
      } else {
        billedByDay = new Map();
        for (const group of matching) {
          for (const point of group.points) {
            const day = point.bucket.slice(0, 10);
            billedByDay.set(day, (billedByDay.get(day) ?? 0) + point.amount);
          }
        }
      }
    } catch (e) {
      billedError = e instanceof Error ? e.message : String(e);
    }
  }

  // Apportion day by day.
  const allocatedByRow = new Map<NetworkFlowSourceDayRow, number>();
  let billedTotal = 0;
  let unallocated = 0;
  let scaledDays = 0;
  let daysWithoutBilled = 0;
  const bases = new Set<"cost" | "bytes" | "none">();
  if (billedByDay) {
    const byDay = new Map<string, NetworkFlowSourceDayRow[]>();
    for (const row of dayRows) {
      const list = byDay.get(row.day);
      if (list) list.push(row);
      else byDay.set(row.day, [row]);
    }
    const days = new Set([...byDay.keys(), ...billedByDay.keys()]);
    for (const day of days) {
      const rows = byDay.get(day) ?? [];
      const billed = billedByDay.get(day);
      if (billed === undefined) {
        if (rows.length > 0) daysWithoutBilled += 1;
        continue;
      }
      billedTotal += billed;
      const result = apportionBilledDay(
        rows.map((r) => ({ bytes: r.bytes, estimatedCost: r.estimated_cost })),
        billed,
      );
      rows.forEach((r, i) => allocatedByRow.set(r, result.allocated[i] ?? 0));
      unallocated += result.unallocated;
      if (result.scaled) scaledDays += 1;
      if (rows.length > 0) bases.add(result.basis);
    }
  }
  const allocating = billedByDay !== null;

  // Roll up by workload, namespace and boundary.
  const workloads = new Map<string, KubernetesNetworkRow>();
  const scopes = new Map<NetworkFlowScope, KubernetesNetworkScopeRow>();
  const methods = new Map<KubernetesNetworkMethod, number>();
  for (const row of dayRows) {
    const scope = row.scope as NetworkFlowScope;
    const allocated = allocatedByRow.get(row) ?? 0;
    let entry = workloads.get(row.src_ref);
    if (!entry) {
      entry = {
        key: row.src_ref,
        ...classifyRef(row.src_ref, row.src_label),
        bytes: 0,
        estimatedCost: 0,
        allocatedCost: allocating ? 0 : null,
        byScope: {},
        method: row.method as KubernetesNetworkMethod,
      };
      workloads.set(row.src_ref, entry);
    }
    entry.bytes += row.bytes;
    entry.estimatedCost += row.estimated_cost;
    if (entry.allocatedCost !== null) entry.allocatedCost += allocated;
    entry.byScope[scope] = (entry.byScope[scope] ?? 0) + row.bytes;
    entry.method = weaker(entry.method, row.method);

    let scopeEntry = scopes.get(scope);
    if (!scopeEntry) {
      scopeEntry = { scope, bytes: 0, estimatedCost: 0, allocatedCost: allocating ? 0 : null };
      scopes.set(scope, scopeEntry);
    }
    scopeEntry.bytes += row.bytes;
    scopeEntry.estimatedCost += row.estimated_cost;
    if (scopeEntry.allocatedCost !== null) scopeEntry.allocatedCost += allocated;

    const method = (row.method || "") as KubernetesNetworkMethod;
    methods.set(method, (methods.get(method) ?? 0) + row.bytes);
  }

  const namespaces = new Map<string, KubernetesNetworkRow>();
  for (const row of workloads.values()) {
    if (row.kind !== "workload" || !row.namespace) continue;
    let ns = namespaces.get(row.namespace);
    if (!ns) {
      ns = {
        key: row.namespace,
        label: row.namespace,
        namespace: row.namespace,
        kind: "namespace",
        bytes: 0,
        estimatedCost: 0,
        allocatedCost: allocating ? 0 : null,
        byScope: {},
        method: row.method,
      };
      namespaces.set(row.namespace, ns);
    }
    ns.bytes += row.bytes;
    ns.estimatedCost += row.estimatedCost;
    if (ns.allocatedCost !== null) ns.allocatedCost += row.allocatedCost ?? 0;
    for (const [scope, bytes] of Object.entries(row.byScope) as [NetworkFlowScope, number][]) {
      ns.byScope[scope] = (ns.byScope[scope] ?? 0) + bytes;
    }
    ns.method = weaker(ns.method, row.method);
  }

  const byMoney = (a: KubernetesNetworkRow, b: KubernetesNetworkRow) =>
    (b.allocatedCost ?? b.estimatedCost) - (a.allocatedCost ?? a.estimatedCost) ||
    b.bytes - a.bytes ||
    a.key.localeCompare(b.key);

  const allRows = [...workloads.values()];
  const bytes = allRows.reduce((a, r) => a + r.bytes, 0);
  const estimatedCost = allRows.reduce((a, r) => a + r.estimatedCost, 0);
  const allocatedCost = allocating ? allRows.reduce((a, r) => a + (r.allocatedCost ?? 0), 0) : null;

  const basis: KubernetesNetworkReport["billed"]["basis"] = bases.has("bytes")
    ? "bytes"
    : bases.has("cost")
      ? "cost"
      : "none";

  return {
    accountId,
    displayName: account.displayName,
    range,
    estimated: true,
    currency,
    totals: {
      bytes,
      estimatedCost,
      allocatedCost,
      unallocatedCost: allocating ? unallocated : null,
    },
    billed: {
      query: settings.billedQuery,
      error: billedError,
      billedCost: allocating ? billedTotal : null,
      basis,
      scaledDays,
      daysWithoutBilled,
    },
    scopes: [...scopes.values()].sort(
      (a, b) =>
        (b.allocatedCost ?? b.estimatedCost) - (a.allocatedCost ?? a.estimatedCost) ||
        b.bytes - a.bytes,
    ),
    methods: [...methods]
      .map(([method, b]) => ({ method, bytes: b }))
      .sort((a, b) => b.bytes - a.bytes),
    namespaces: [...namespaces.values()].sort(byMoney),
    workloads: allRows.sort(byMoney),
    topTalkers: pairs.map(toPairView),
    collection: statuses.find((s) => s.accountId === accountId) ?? null,
  };
}
