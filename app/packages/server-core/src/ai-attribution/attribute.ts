/**
 * The attribution arithmetic: split one org-day's billed AI rows between
 * callers using that day's request aggregates. Pure and db-free so every rule
 * below is pinned by `__tests__/ai-attribution.test.ts`.
 *
 * ## The model
 *
 * 1. **Group the bill** by (provider, normalized model, token type, currency),
 *    at whatever grain the provider's billing API reports. Anthropic and
 *    OpenAI name model and token type; Bedrock's Marketplace editions name the
 *    model; Vertex and Azure OpenAI are provider-level only.
 * 2. **Match each request aggregate** to the finest group that fits: the same
 *    normalized model, else a single billed model the request's model is a
 *    prefix of (or vice versa; more than one such model is *ambiguous* and the
 *    request is split between them by billed amount), else the provider-level
 *    group, else nothing (*unmatched*: counted, never forced onto a line).
 * 3. **Weigh** each matched aggregate against its group. A typed group weighs
 *    only that token type; an untyped group weighs every type. The weight is a
 *    list-price cost when a rate card or the gateway's own reported cost gives
 *    one (*priced*), else relative token weights (*unpriced*).
 * 4. **Scale.** For a fully priced group, callers receive
 *    `listCost × min(1, billed / listCost)` and the rest of the bill is
 *    `(unattributed)`: logs that explain $40 of a $100 line attribute $40, not
 *    $100. An unpriced group has no money to compare with, so its whole bill is
 *    split by weight. A group with no matching requests is wholly
 *    unattributed. A non-positive group (credits, refunds) is split by weight
 *    without the cap.
 *
 * Every billed row in a group is split by the same fractions, so per-row splits
 * sum to the row and per-day totals equal the bill exactly: the attributed view
 * can only relabel money, never create or lose it.
 */
import {
  AI_COST_TAG,
  DEFAULT_TOKEN_WEIGHTS,
  normalizeAiModel,
  normalizeAiProvider,
  type AiModelRateCard,
  type AiTokenType,
} from "@infrawrench/plugin-base";
import { AI_NOT_SET_VALUE, AI_UNATTRIBUTED_VALUE, aiCallerTagKey } from "@infrawrench/client-core";

/** One billed `cost_daily` row carrying `ai:provider`. Extra fields ride along untouched. */
export interface BilledAiRow {
  tags: Record<string, string>;
  currency: string;
  amount: number;
  usage_amount: number;
  amortized_amount: number;
}

/** One request aggregate from the latest collection of a source. */
export interface RequestAggregateInput {
  sourceId: string;
  provider: string;
  model: string;
  metadata: Record<string, string>;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  reportedCost: number | null;
  reportedCurrency: string | null;
}

export interface DimensionMapping {
  key: string;
  metadataKeys: string[];
}

export interface SourceDayStats {
  requests: number;
  matchedRequests: number;
  ambiguousRequests: number;
  unmatchedRequests: number;
  attributed: Record<string, number>;
  billed: Record<string, number>;
}

export interface ProviderDayStats {
  provider: string;
  currency: string;
  billed: number;
  attributed: number;
}

export interface AttributionResult<R extends BilledAiRow> {
  /** Split rows: each input row once per caller share, tags extended. */
  rows: Array<R & { tags: Record<string, string> }>;
  sources: Record<string, SourceDayStats>;
  providers: ProviderDayStats[];
}

interface Group {
  key: string;
  provider: string;
  model: string;
  tokenType: AiTokenType | "";
  currency: string;
  billed: number;
  rows: BilledAiRow[];
}

const TOKEN_FIELDS: Record<AiTokenType, keyof RequestAggregateInput> = {
  input: "inputTokens",
  output: "outputTokens",
  cache_read: "cacheReadTokens",
  cache_write: "cacheWriteTokens",
  reasoning: "reasoningTokens",
};

function tokens(a: RequestAggregateInput, t: AiTokenType): number {
  const v = a[TOKEN_FIELDS[t]];
  return typeof v === "number" && v > 0 ? v : 0;
}

function rateFor(
  cards: Map<string, AiModelRateCard>,
  provider: string,
  model: string,
): { card: AiModelRateCard; rates: Record<AiTokenType, number> } | null {
  const card = cards.get(provider);
  const r = card?.models[model];
  if (!card || !r) return null;
  return {
    card,
    rates: {
      input: r.input,
      output: r.output,
      cache_read: r.cacheRead ?? r.input,
      cache_write: r.cacheWrite ?? r.input,
      reasoning: r.reasoning ?? r.output,
    },
  };
}

/** Caller values for one aggregate, one per dimension. */
export function callerValues(
  metadata: Record<string, string>,
  dimensions: DimensionMapping[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of dimensions) {
    let value: string | undefined;
    for (const k of d.metadataKeys) {
      const v = metadata[k];
      if (v !== undefined && v !== "") {
        value = v;
        break;
      }
    }
    out[d.key] = value ?? AI_NOT_SET_VALUE;
  }
  return out;
}

function callerKey(values: Record<string, string>): string {
  return Object.keys(values)
    .sort()
    .map((k) => `${k}\u0001${values[k]}`)
    .join("\u0002");
}

function addTo(map: Record<string, number>, currency: string, amount: number): void {
  map[currency] = (map[currency] ?? 0) + amount;
}

/**
 * Split one org-day. `rateCards` is keyed by canonical provider id.
 * Dimensions may be empty: the run still produces stats, and every split row
 * carries no caller tags (the caller view then shows only the bill).
 */
export function attributeDay<R extends BilledAiRow>(
  billedRows: R[],
  aggregates: RequestAggregateInput[],
  dimensions: DimensionMapping[],
  rateCards: Map<string, AiModelRateCard>,
): AttributionResult<R> {
  // 1. Group the bill.
  const groups = new Map<string, Group>();
  for (const row of billedRows) {
    const provider = normalizeAiProvider(row.tags[AI_COST_TAG.provider] ?? "");
    if (!provider) continue;
    const rawModel = row.tags[AI_COST_TAG.model] ?? "";
    const model = rawModel ? normalizeAiModel(rawModel) : "";
    const tokenType = (row.tags[AI_COST_TAG.tokenType] ?? "") as AiTokenType | "";
    const key = `${provider}\u0000${model}\u0000${tokenType}\u0000${row.currency}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, provider, model, tokenType, currency: row.currency, billed: 0, rows: [] };
      groups.set(key, g);
    }
    g.billed += row.amount;
    g.rows.push(row);
  }

  const modelsByProvider = new Map<string, Map<string, number>>();
  const providerLevel = new Set<string>();
  for (const g of groups.values()) {
    if (!g.model) {
      providerLevel.add(g.provider);
      continue;
    }
    const m = modelsByProvider.get(g.provider) ?? new Map<string, number>();
    m.set(g.model, (m.get(g.model) ?? 0) + Math.abs(g.billed));
    modelsByProvider.set(g.provider, m);
  }

  const sources: Record<string, SourceDayStats> = {};
  const statsFor = (id: string) =>
    (sources[id] ??= {
      requests: 0,
      matchedRequests: 0,
      ambiguousRequests: 0,
      unmatchedRequests: 0,
      attributed: {},
      billed: {},
    });

  // 2. Match each aggregate to model targets with a fraction each.
  interface Contribution {
    agg: RequestAggregateInput;
    fraction: number;
    callers: Record<string, string>;
  }
  const byGroup = new Map<string, Contribution[]>();
  const touched = new Map<string, Set<string>>(); // sourceId -> group keys
  for (const agg of aggregates) {
    const provider = normalizeAiProvider(agg.provider);
    const model = normalizeAiModel(agg.model);
    const st = statsFor(agg.sourceId);
    st.requests += agg.requests;
    const known = modelsByProvider.get(provider);
    let targets: Array<{ model: string; fraction: number }> = [];
    let ambiguous = false;
    if (known?.has(model)) {
      targets = [{ model, fraction: 1 }];
    } else if (known) {
      const loose = [...known.entries()].filter(
        ([m]) => m.startsWith(`${model}-`) || model.startsWith(`${m}-`),
      );
      if (loose.length === 1) {
        targets = [{ model: loose[0]![0], fraction: 1 }];
      } else if (loose.length > 1) {
        ambiguous = true;
        const total = loose.reduce((s, [, amt]) => s + amt, 0);
        targets = loose.map(([m, amt]) => ({
          model: m,
          fraction: total > 0 ? amt / total : 1 / loose.length,
        }));
      }
    }
    if (targets.length === 0 && providerLevel.has(provider)) {
      targets = [{ model: "", fraction: 1 }];
    }
    if (targets.length === 0) {
      st.unmatchedRequests += agg.requests;
      continue;
    }
    st.matchedRequests += agg.requests;
    if (ambiguous) st.ambiguousRequests += agg.requests;
    const callers = callerValues(agg.metadata, dimensions);
    for (const g of groups.values()) {
      if (g.provider !== provider) continue;
      const target = targets.find((t) => t.model === g.model);
      if (!target) continue;
      const list = byGroup.get(g.key) ?? [];
      list.push({ agg, fraction: target.fraction, callers });
      byGroup.set(g.key, list);
      const set = touched.get(agg.sourceId) ?? new Set<string>();
      set.add(g.key);
      touched.set(agg.sourceId, set);
    }
  }

  // 3–4. Weigh and scale per group.
  const outRows: Array<R & { tags: Record<string, string> }> = [];
  const providerStats = new Map<string, ProviderDayStats>();
  const unattributedTags: Record<string, string> = {};
  for (const d of dimensions) unattributedTags[aiCallerTagKey(d.key)] = AI_UNATTRIBUTED_VALUE;

  for (const g of groups.values()) {
    const contributions = byGroup.get(g.key) ?? [];
    const types: AiTokenType[] = g.tokenType
      ? [g.tokenType]
      : ["input", "output", "cache_read", "cache_write", "reasoning"];
    let allPriced = contributions.length > 0;
    const weighed = contributions.map((c) => {
      const model = normalizeAiModel(c.agg.model);
      const rate = rateFor(rateCards, g.provider, g.model || model);
      let listCost: number | null = null;
      if (rate && rate.card.currency.toUpperCase() === g.currency.toUpperCase()) {
        listCost = types.reduce((s, t) => s + (tokens(c.agg, t) * rate.rates[t]) / 1_000_000, 0);
      } else if (
        !g.tokenType &&
        c.agg.reportedCost !== null &&
        (c.agg.reportedCurrency ?? "USD").toUpperCase() === g.currency.toUpperCase()
      ) {
        listCost = c.agg.reportedCost;
      }
      if (listCost === null) allPriced = false;
      const tokenWeight = types.reduce(
        (s, t) => s + tokens(c.agg, t) * DEFAULT_TOKEN_WEIGHTS[t],
        0,
      );
      return {
        c,
        listCost: (listCost ?? 0) * c.fraction,
        weight: tokenWeight * c.fraction,
      };
    });

    // Caller → attributed money for this group.
    const perCaller = new Map<string, { callers: Record<string, string>; amount: number }>();
    const perSource = new Map<string, number>();
    let attributedTotal = 0;
    if (weighed.length > 0) {
      const totalList = weighed.reduce((s, w) => s + w.listCost, 0);
      const totalWeight = weighed.reduce((s, w) => s + w.weight, 0);
      const usePriced = allPriced && totalList > 0 && g.billed > 0;
      const denominator = usePriced ? totalList : totalWeight;
      if (denominator > 0) {
        const scale = usePriced ? Math.min(1, g.billed / totalList) : g.billed / totalWeight;
        for (const w of weighed) {
          const amount = (usePriced ? w.listCost : w.weight) * scale;
          if (amount === 0) continue;
          const key = callerKey(w.c.callers);
          const entry = perCaller.get(key) ?? { callers: w.c.callers, amount: 0 };
          entry.amount += amount;
          perCaller.set(key, entry);
          perSource.set(w.c.agg.sourceId, (perSource.get(w.c.agg.sourceId) ?? 0) + amount);
          attributedTotal += amount;
        }
      }
    }

    // Split every billed row in the group by the same fractions.
    const shares: Array<{ tags: Record<string, string>; fraction: number }> = [];
    if (g.billed !== 0) {
      for (const { callers, amount } of perCaller.values()) {
        const tags: Record<string, string> = {};
        for (const [k, v] of Object.entries(callers)) tags[aiCallerTagKey(k)] = v;
        shares.push({ tags, fraction: amount / g.billed });
      }
      const rest = 1 - shares.reduce((s, x) => s + x.fraction, 0);
      if (Math.abs(rest) > 1e-12) shares.push({ tags: unattributedTags, fraction: rest });
    } else {
      // A zero-sum group still has rows (a usage line and its equal credit):
      // keep them whole under the unattributed label.
      shares.push({ tags: unattributedTags, fraction: 1 });
    }
    for (const row of g.rows) {
      for (const share of shares) {
        outRows.push({
          ...(row as R),
          tags: { ...row.tags, ...share.tags },
          amount: row.amount * share.fraction,
          usage_amount: row.usage_amount * share.fraction,
          amortized_amount: row.amortized_amount * share.fraction,
        });
      }
    }

    const pKey = `${g.provider}\u0000${g.currency}`;
    const ps = providerStats.get(pKey) ?? {
      provider: g.provider,
      currency: g.currency,
      billed: 0,
      attributed: 0,
    };
    ps.billed += g.billed;
    ps.attributed += attributedTotal;
    providerStats.set(pKey, ps);
    for (const [sourceId, amount] of perSource)
      addTo(statsFor(sourceId).attributed, g.currency, amount);
  }

  for (const [sourceId, keys] of touched) {
    const st = statsFor(sourceId);
    for (const key of keys) {
      const g = groups.get(key)!;
      addTo(st.billed, g.currency, g.billed);
    }
  }

  return { rows: outRows, sources, providers: [...providerStats.values()] };
}
