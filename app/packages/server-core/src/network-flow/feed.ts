/**
 * The read model behind the network-costs screen.
 *
 * One call, because the questions are only useful together: a top-flows list
 * without the boundary summary hides how much of the bill it accounts for, the
 * boundary summary without the account status hides that half the estate has no
 * flow source at all, and either without the rate card hides that the money is
 * an estimate at list price.
 */
import type {
  NetworkFlowAccountStatus,
  NetworkFlowFeed,
  NetworkFlowPairView,
  NetworkFlowRateCardView,
  NetworkFlowScopeSummary,
} from "@infrawrench/client-core";
import type { NetworkFlowScope } from "@infrawrench/plugin-base";
import { and, eq, isNull } from "drizzle-orm";

import {
  readNetworkFlowScopeTotals,
  readTopNetworkFlows,
  type NetworkFlowFilters,
} from "../clickhouse/network-flow-readers";
import { db } from "../db/client";
import { accountNetworkFlowPolls, accounts } from "../db/schema";
import { loadPlugins } from "../plugin-loader";

import { boundaryFlags } from "./pricing";
import { getNetworkFlowSettings } from "./settings";

export interface NetworkFlowFeedOptions {
  from: string;
  to: string;
  limit?: number;
  scope?: string | undefined;
  accountId?: string | undefined;
}

function bucket(scope: NetworkFlowScope, direction: "egress" | "ingress"): string {
  return `${scope} ${direction}`;
}

/**
 * Fold the per-(scope, direction, attribution) totals into one summary row per
 * boundary, keeping the unattributed and truncated weights as their own fields.
 *
 * They are fields rather than separate rows because they are not separate
 * traffic: `unattributedBytes` is a *subset* of `bytes`, not an addition to it,
 * and rendering them as sibling rows is how a reader ends up double-counting
 * the tail into the total.
 */
function summarizeScopes(
  rows: Awaited<ReturnType<typeof readNetworkFlowScopeTotals>>,
): NetworkFlowScopeSummary[] {
  const byBucket = new Map<string, NetworkFlowScopeSummary>();
  for (const row of rows) {
    const scope = row.scope as NetworkFlowScope;
    const direction = row.direction === "ingress" ? "ingress" : "egress";
    const key = bucket(scope, direction);
    let entry = byBucket.get(key);
    if (!entry) {
      entry = {
        scope,
        direction,
        bytes: 0,
        estimatedCost: 0,
        currency: row.currency || "USD",
        ...boundaryFlags(scope),
        unattributedBytes: 0,
        truncatedBytes: 0,
      };
      byBucket.set(key, entry);
    }
    entry.bytes += Number(row.bytes) || 0;
    entry.estimatedCost += Number(row.estimated_cost) || 0;
    if (row.attribution === "unattributed") entry.unattributedBytes += Number(row.bytes) || 0;
    if (row.attribution === "truncated") entry.truncatedBytes += Number(row.bytes) || 0;
  }
  return [...byBucket.values()].sort(
    (a, b) => b.estimatedCost - a.estimatedCost || b.bytes - a.bytes,
  );
}

function toPairView(
  row: Awaited<ReturnType<typeof readTopNetworkFlows>>[number],
): NetworkFlowPairView {
  return {
    source: {
      ref: row.src_ref,
      label: row.src_label || row.src_ref,
      zone: row.src_zone,
      region: row.src_region,
      service: row.src_service,
      resourceTypeId: row.src_resource_type_id,
    },
    destination: {
      ref: row.dst_ref,
      label: row.dst_label || row.dst_ref,
      zone: row.dst_zone,
      region: row.dst_region,
      service: row.dst_service,
      resourceTypeId: row.dst_resource_type_id,
    },
    scope: row.scope as NetworkFlowScope,
    direction: row.direction === "ingress" ? "ingress" : "egress",
    attribution: row.attribution === "unattributed" ? "unattributed" : "resolved",
    bytes: Number(row.bytes) || 0,
    packets: Number(row.packets) || 0,
    estimatedCost: Number(row.estimated_cost) || 0,
    currency: row.currency || "USD",
    accountId: row.account_id,
    pluginId: row.plugin_id,
    days: Number(row.days) || 0,
  };
}

/**
 * Per-account capability and collection state.
 *
 * Every live account is listed, including the ones whose plugin cannot report
 * flows at all — with `supportsFlows: false` and nothing else. That is the
 * "degrade to nothing rather than to zero" rule made concrete: an Azure account
 * appears in this list saying we cannot see its flows, rather than appearing in
 * the totals contributing 0 bytes, which would read as "Azure sends no traffic".
 */
async function loadAccountStatuses(organizationId: string): Promise<NetworkFlowAccountStatus[]> {
  const [rows, polls, loaded] = await Promise.all([
    db
      .select({
        id: accounts.id,
        pluginId: accounts.pluginId,
        displayName: accounts.displayName,
      })
      .from(accounts)
      .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt))),
    db
      .select()
      .from(accountNetworkFlowPolls)
      .where(eq(accountNetworkFlowPolls.organizationId, organizationId)),
    loadPlugins(),
  ]);

  const flowCapable = new Set(
    loaded.filter((l) => l.plugin.manifest.networkFlows).map((l) => l.plugin.manifest.id),
  );
  const pollByAccount = new Map(polls.map((p) => [p.accountId, p]));

  return rows.map((row) => {
    const poll = pollByAccount.get(row.id);
    const supportsFlows = flowCapable.has(row.pluginId);
    return {
      accountId: row.id,
      pluginId: row.pluginId,
      displayName: row.displayName,
      supportsFlows,
      collectedThrough: poll?.collectedThrough ? String(poll.collectedThrough) : null,
      lastPolledAt: poll?.lastPolledAt ? poll.lastPolledAt.toISOString() : null,
      failureCount: poll?.failureCount ?? 0,
      lastError: poll?.lastError ?? null,
      lastErrorHelpUrl: poll?.lastErrorHelpUrl ?? null,
      sources: (poll?.lastSources ?? []).map((s) => ({
        id: s.id,
        target: s.target,
        region: s.region ?? null,
        destinationType: s.destinationType,
        usable: s.usable,
        unusableReason: s.unusableReason ?? null,
        helpUrl: s.helpUrl ?? null,
      })),
      lastQueryBytesScanned: poll?.lastQueryBytesScanned ?? null,
    };
  });
}

/**
 * The rate cards in play, so a figure on the screen can be traced to the
 * published number it came from and the date that number was last checked.
 * Only cards for plugins the org actually has an account on — a rate card for a
 * provider they do not use is noise that makes the ones they do use harder to
 * audit.
 */
async function loadRateCards(pluginIds: Set<string>): Promise<NetworkFlowRateCardView[]> {
  const loaded = await loadPlugins();
  return loaded.flatMap((l) => {
    const cap = l.plugin.manifest.networkFlows;
    if (!cap || !pluginIds.has(l.plugin.manifest.id)) return [];
    return [
      {
        pluginId: l.plugin.manifest.id,
        currency: cap.rates.currency,
        asOf: cap.rates.asOf,
        perGb: cap.rates.perGb,
        queriesBillable: cap.queriesBillable === true,
        sampled: cap.sampled === true,
      },
    ];
  });
}

export async function getNetworkFlowFeed(
  organizationId: string,
  options: NetworkFlowFeedOptions,
): Promise<NetworkFlowFeed> {
  const filters: NetworkFlowFilters = {
    ...(options.accountId ? { accountId: options.accountId } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
  };
  const range = { from: options.from, to: options.to };

  const [settings, scopeRows, pairRows, accountStatuses] = await Promise.all([
    getNetworkFlowSettings(organizationId),
    readNetworkFlowScopeTotals(organizationId, range, filters),
    readTopNetworkFlows(organizationId, range, filters, options.limit ?? 50),
    loadAccountStatuses(organizationId),
  ]);

  const scopes = summarizeScopes(scopeRows);
  const rateCards = await loadRateCards(new Set(accountStatuses.map((a) => a.pluginId)));

  const totals = scopes.reduce(
    (acc, s) => ({
      bytes: acc.bytes + s.bytes,
      estimatedCost: acc.estimatedCost + s.estimatedCost,
      currency: acc.currency || s.currency,
      unattributedBytes: acc.unattributedBytes + s.unattributedBytes,
      truncatedBytes: acc.truncatedBytes + s.truncatedBytes,
    }),
    { bytes: 0, estimatedCost: 0, currency: "", unattributedBytes: 0, truncatedBytes: 0 },
  );

  return {
    enabled: settings.enabled,
    initialLookbackDays: settings.initialLookbackDays,
    estimated: true,
    range,
    scopes,
    topFlows: pairRows.map(toPairView),
    accounts: accountStatuses,
    rateCards,
    totals: { ...totals, currency: totals.currency || rateCards[0]?.currency || "USD" },
  };
}
