/**
 * Range summaries over the per-day run records: match rate per source and
 * billed-versus-attributed coverage per provider, plus the spend-by-caller
 * breakdown. Pure folding is in {@link summarizeAiAttributionDays} so it can be
 * tested without a database.
 */
import {
  aiCallerTagKey,
  type AiAttributionStats,
  type AiProviderCoverage,
  type AiSourceMatchStats,
  type AiSpendBreakdown,
} from "@infrawrench/client-core";
import { and, eq, gte, lte } from "drizzle-orm";

import { db } from "../db/client";
import {
  aiAttributionDays,
  aiRequestSources,
  type AiAttributionDayProviderStats,
  type AiAttributionDaySourceStats,
} from "../db/schema";
import { querySpendByCallerTag } from "../clickhouse/cost-readers";
import { isCostScoped } from "../cost/visibility-context";

export interface DayRecord {
  runAt: Date | null;
  sources: Record<string, AiAttributionDaySourceStats>;
  providers: AiAttributionDayProviderStats[];
}

/** Fold day records into range statistics. */
export function summarizeAiAttributionDays(
  from: string,
  to: string,
  days: DayRecord[],
  sourceNames: Map<string, string>,
): AiAttributionStats {
  const bySource = new Map<
    string,
    AiSourceMatchStats & { _attr: Record<string, number>; _billed: Record<string, number> }
  >();
  const byProvider = new Map<string, AiProviderCoverage>();
  let attributedDays = 0;
  for (const d of days) {
    if (d.runAt) attributedDays++;
    for (const [id, s] of Object.entries(d.sources)) {
      let acc = bySource.get(id);
      if (!acc) {
        acc = {
          sourceId: id,
          name: sourceNames.get(id) ?? id,
          days: 0,
          requests: 0,
          matchedRequests: 0,
          ambiguousRequests: 0,
          unmatchedRequests: 0,
          skippedRecords: 0,
          currency: null,
          attributedAmount: 0,
          billedAmount: 0,
          coveragePercent: null,
          degradedDays: 0,
          truncatedDays: 0,
          _attr: {},
          _billed: {},
        };
        bySource.set(id, acc);
      }
      acc.days++;
      acc.requests += s.requests;
      acc.matchedRequests += s.matchedRequests;
      acc.ambiguousRequests += s.ambiguousRequests;
      acc.unmatchedRequests += s.unmatchedRequests;
      acc.skippedRecords += s.skippedRecords;
      if (s.degraded) acc.degradedDays++;
      if (s.truncated) acc.truncatedDays++;
      for (const [c, v] of Object.entries(s.attributed)) acc._attr[c] = (acc._attr[c] ?? 0) + v;
      for (const [c, v] of Object.entries(s.billed)) acc._billed[c] = (acc._billed[c] ?? 0) + v;
    }
    for (const p of d.providers) {
      const key = `${p.provider}\u0000${p.currency}`;
      const acc = byProvider.get(key) ?? {
        provider: p.provider,
        currency: p.currency,
        billedAmount: 0,
        attributedAmount: 0,
        unattributedAmount: 0,
      };
      acc.billedAmount += p.billed;
      acc.attributedAmount += p.attributed;
      acc.unattributedAmount = acc.billedAmount - acc.attributedAmount;
      byProvider.set(key, acc);
    }
  }
  const sources: AiSourceMatchStats[] = [...bySource.values()].map(({ _attr, _billed, ...s }) => {
    // Report in the currency carrying the most billed money; mixed-currency
    // sources are rare and the per-provider table carries every currency.
    const currency =
      Object.entries(_billed).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0]?.[0] ??
      Object.keys(_attr)[0] ??
      null;
    const attributedAmount = currency ? (_attr[currency] ?? 0) : 0;
    const billedAmount = currency ? (_billed[currency] ?? 0) : 0;
    return {
      ...s,
      currency,
      attributedAmount,
      billedAmount,
      coveragePercent: billedAmount > 0 ? (attributedAmount / billedAmount) * 100 : null,
    };
  });
  for (const [id, name] of sourceNames) {
    if (!bySource.has(id)) {
      sources.push({
        sourceId: id,
        name,
        days: 0,
        requests: 0,
        matchedRequests: 0,
        ambiguousRequests: 0,
        unmatchedRequests: 0,
        skippedRecords: 0,
        currency: null,
        attributedAmount: 0,
        billedAmount: 0,
        coveragePercent: null,
        degradedDays: 0,
        truncatedDays: 0,
      });
    }
  }
  return {
    from,
    to,
    sources,
    providers: [...byProvider.values()].sort((a, b) => b.billedAmount - a.billedAmount),
    attributedDays,
  };
}

export async function getAiAttributionStats(
  organizationId: string,
  from: string,
  to: string,
): Promise<AiAttributionStats> {
  const [days, sources] = await Promise.all([
    db
      .select({
        runAt: aiAttributionDays.runAt,
        sources: aiAttributionDays.sources,
        providers: aiAttributionDays.providers,
      })
      .from(aiAttributionDays)
      .where(
        and(
          eq(aiAttributionDays.organizationId, organizationId),
          gte(aiAttributionDays.day, from),
          lte(aiAttributionDays.day, to),
        ),
      ),
    db
      .select({ id: aiRequestSources.id, name: aiRequestSources.name })
      .from(aiRequestSources)
      .where(eq(aiRequestSources.organizationId, organizationId)),
  ]);
  const stats = summarizeAiAttributionDays(
    from,
    to,
    days,
    new Map(sources.map((s) => [s.id, s.name])),
  );
  // The run records are whole-org money with no cost row to test a visibility
  // scope against, so a cost-scoped caller gets the match counts only.
  if (isCostScoped(organizationId)) {
    return {
      ...stats,
      providers: [],
      sources: stats.sources.map((s) => ({
        ...s,
        currency: null,
        attributedAmount: 0,
        billedAmount: 0,
        coveragePercent: null,
      })),
    };
  }
  return stats;
}

export async function getAiSpendBreakdown(
  organizationId: string,
  dimension: string,
  from: string,
  to: string,
): Promise<AiSpendBreakdown> {
  const tagKey = aiCallerTagKey(dimension);
  const rows = await querySpendByCallerTag(organizationId, tagKey, from, to);
  return { from, to, dimension, tagKey, rows };
}
