// `infrawrench costs`: org cost graphs in the terminal, backed by the same
// /costs/query API the web + desktop dashboards use.
//
// The request/response shapes come from `@infrawrench/client-core`: the same
// definitions the web, desktop, and mobile cost views describe the wire with,
// so a server-side change breaks the CLI's build instead of its output. The
// import is type-only, so the CLI still ships zero new runtime dependencies.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  CostAccountStatus,
  CostAlert,
  CostAlertEvent,
  CostAnomaly,
  CostBasis,
  CostBinningId,
  CostChargeType,
  CostConversion,
  CostDimensionOption,
  CostMeasure,
  CostDimensionId,
  CostFilter,
  CostQueryRequest,
  CostQueryResponse,
  KeyedCostDimensionId,
  SavedCostFilter,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import type { RangeFlags } from "../args";
import { resolveDayWindow, resolveDateRange } from "../args";
import { c, printJson, println, printTable, formatMoney, seriesColor } from "../output";
import {
  anomalyDeltaPercent,
  anomalyFeedbackLabel,
  formatGroupBy,
  KEYED_GROUP_DIMENSIONS,
  parseGroupByFlag,
  shortId,
} from "../format";
import { barChart, sparkline } from "../charts";

const GROUP_DIMENSIONS = [
  "provider",
  "account",
  "service",
  "region",
  "resource",
  "charge_type",
  "commitment",
] as const satisfies readonly CostDimensionId[];

// The keyed dimensions (`tag:env`, `virtual_tag:team`) are parsed by
// `parseGroupByFlag`; pinned to the wire type here so a dimension renamed
// upstream fails this file's typecheck rather than a request.
const KEYED_DIMENSIONS: readonly KeyedCostDimensionId[] = KEYED_GROUP_DIMENSIONS;

/**
 * The two money bases and the charge types, restated as plain arrays.
 *
 * The wire types above are imported type-only so the CLI keeps its zero runtime
 * dependencies; a `const` from client-core would be a real import. Drift is
 * caught at build time anyway: the values are assigned to the imported types
 * below, so removing a charge type upstream fails this file's typecheck.
 */
const COST_BASES: readonly CostBasis[] = ["cash", "amortized", "blended"];
const CHARGE_TYPES: readonly CostChargeType[] = [
  "usage",
  "commitment_covered_usage",
  "commitment_fee",
  "commitment_discount",
  "credit",
  "tax",
  "refund",
  "adjustment",
  "support",
  "other",
];

/** The measures, restated for the same zero-runtime-dependency reason. */
const MEASURES: readonly CostMeasure[] = ["cost", "usage", "count"];

/**
 * `--bin` spellings: the short noun (`quarter`, the one people type) or the
 * API's own adjective (`quarterly`), both accepted.
 */
const BINS: Record<string, CostBinningId> = {
  hour: "hourly",
  hourly: "hourly",
  day: "daily",
  daily: "daily",
  week: "weekly",
  weekly: "weekly",
  month: "monthly",
  monthly: "monthly",
  quarter: "quarterly",
  quarterly: "quarterly",
};

/** The display options `costs` and `reports` share, parsed and checked. */
export interface DisplayFlags {
  measure?: CostMeasure;
  binning?: CostBinningId;
  usageUnit?: string;
  cumulative?: boolean;
}

/**
 * `--measure`, `--bin`, `--unit`, `--cumulative` → the request fields, each
 * omitted when not given so an older server answers the request it always
 * did. Shape errors are caught here; the cross-field rules (a usage query
 * needs a unit, a count needs a group-by) are the shared `costDisplayProblem`,
 * checked by the caller once it knows the group-by.
 */
export function parseDisplayFlags(range: RangeFlags): DisplayFlags {
  const flags: DisplayFlags = {};
  if (range.measure !== undefined) {
    const measure = MEASURES.find((m) => m === range.measure);
    if (!measure) {
      throw new CliError(
        `--measure must be one of ${MEASURES.join(", ")} — got "${range.measure}".`,
        2,
      );
    }
    flags.measure = measure;
  }
  if (range.bin !== undefined) {
    const binning = BINS[range.bin.toLowerCase()];
    if (!binning) {
      throw new CliError(
        `--bin must be one of hour, day, week, month, quarter — got "${range.bin}".`,
        2,
      );
    }
    flags.binning = binning;
  }
  const unit = range.unit?.trim();
  if (unit) flags.usageUnit = unit;
  if (range.cumulative) flags.cumulative = true;
  return flags;
}

/**
 * Refuse a combination the server would refuse, before the round trip, in the
 * server's own words (the rule is client-core's `costDisplayProblem`). A usage
 * query without a unit gets the units the org actually has listed, so the fix
 * is in the error message.
 */
export async function checkDisplayFlags(
  orgId: string,
  q: {
    measure?: CostMeasure | undefined;
    usageUnit?: string | undefined;
    groupBy: CostQueryRequest["groupBy"];
    binning: CostBinningId;
    cumulative?: boolean | undefined;
  },
): Promise<void> {
  if (q.measure === "usage" && !q.usageUnit) {
    const res = await orgFetch<{ values: CostDimensionOption[] }>(
      orgId,
      "/costs/dimensions?dimension=usage-units",
    );
    const units = (res.values ?? []).map((u) => u.value);
    throw new CliError(
      units.length > 0
        ? `--measure usage needs --unit: quantities in different units cannot be added. Units in your cost data: ${units.slice(0, 20).join(", ")}.`
        : "--measure usage needs --unit, and no connected provider reports usage quantities yet.",
      2,
    );
  }
  const { costDisplayProblem } = await import("@infrawrench/client-core");
  const problem = costDisplayProblem(q);
  if (problem) throw new CliError(problem, 2);
}

/** One value as text, for whichever measure the response carries. */
export function formatMeasureValue(
  amount: number,
  currency: string,
  response: Pick<CostQueryResponse, "measure" | "usageUnit">,
): string {
  if (!response.measure) return formatMoney(amount, currency);
  const n = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: response.measure === "count" ? 0 : Math.abs(amount) < 10 ? 2 : 0,
  }).format(amount);
  return response.measure === "usage" && response.usageUnit ? `${n} ${response.usageUnit}` : n;
}

/** A series' period total: the last point of a running sum, else the sum. */
export function seriesTotal(points: Array<{ amount: number }>, cumulative: boolean): number {
  if (cumulative) return points[points.length - 1]?.amount ?? 0;
  return points.reduce((sum, p) => sum + p.amount, 0);
}

/**
 * `--currency USD`: the display currency to convert into.
 *
 * Validated for shape only. Whether the org has actually configured this
 * currency and stated rates is a server-side question, and the answer comes
 * back in the response's `conversion` block rather than as an error: an org
 * that has not opted in gets its honest per-currency numbers, which is the
 * right outcome, not a failure.
 */
function parseCurrency(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new CliError(`--currency must be a three-letter code like USD — got "${raw}".`, 2);
  }
  return code;
}

/**
 * The conversion caveat, as lines for text mode.
 *
 * Two things, in the order they matter: what got folded in and at whose rates,
 * then what is still outside the headline figure. The second is the one that
 * must never be dropped: a currency with no rate is shown separately, so the
 * big number is not the whole spend and the reader has to be told.
 */
function printConversionNotice(conversion: CostConversion | undefined): void {
  if (!conversion) return;
  const { displayCurrency, converted, unconverted } = conversion;
  if (converted.length === 0 && unconverted.length === 0) return;

  for (const entry of converted) {
    // Stated rates are listed one by one (they are what a reader reconciles
    // against); a daily feed across a quarter is sixty-odd rates, so it is
    // condensed to its range and publication dates. Inlined rather than
    // imported because client-core is type-only here (zero runtime deps).
    const manual = entry.rates.filter((r) => (r.source ?? "manual") === "manual");
    const feed = entry.rates.filter((r) => r.source === "ecb");
    const parts = manual.map((r) => `${r.rate} from ${r.effectiveFrom} (your rate)`);
    if (feed.length === 1) {
      parts.push(`${feed[0]!.rate} (ECB reference rate, ${feed[0]!.effectiveFrom})`);
    } else if (feed.length > 1) {
      const values = feed.map((r) => r.rate);
      const dates = feed.map((r) => r.effectiveFrom).sort();
      parts.push(
        `${Math.min(...values)}–${Math.max(...values)} (ECB reference rates, ${dates[0]} to ${dates[dates.length - 1]})`,
      );
    }
    const rates = parts.join("; ");
    println(
      `${c.dim("·")} ${c.bold(entry.currency)} ${c.dim(`converted to ${displayCurrency} at ${rates}`)}`,
    );
  }
  if (converted.length > 0) {
    println(
      `  ${c.dim(
        "a rate your organization stated always wins over an automatic ECB rate; weekends and holidays carry the last ECB publication; spend already in " +
          displayCurrency +
          " is not converted",
      )}`,
    );
  }
  if (unconverted.length > 0) {
    println(
      `${c.yellow("!")} ${c.bold(unconverted.join(", "))} ${c.dim(`not included in the ${displayCurrency} figure`)}`,
    );
    println(
      `  ${c.dim("no stated or automatic rate covers every day in this range (the ECB does not publish every currency), so these amounts are listed separately in their own currency rather than folded in or dropped")}`,
    );
  }
  println();
}

/** `--basis cash|amortized|blended`, defaulting to cash. */
function parseBasis(raw: string | undefined): CostBasis | undefined {
  if (raw === undefined) return undefined;
  const match = COST_BASES.find((b) => b === raw);
  if (!match) {
    throw new CliError(`--basis must be one of ${COST_BASES.join(", ")} — got "${raw}".`, 2);
  }
  return match;
}

/** Repeated `--charge-type`; empty means every kind, i.e. a net total. */
export function parseChargeTypes(raw: string[] | undefined): CostChargeType[] {
  return (raw ?? []).map((value) => {
    const match = CHARGE_TYPES.find((t) => t === value);
    if (!match) {
      throw new CliError(
        `--charge-type must be one of ${CHARGE_TYPES.join(", ")} — got "${value}".`,
        2,
      );
    }
    return match;
  });
}

/**
 * `--where "provider = 'aws' AND tag['env'] != 'dev'"` → the structured filter.
 *
 * Compiled here rather than posted as the API's `query` field for two reasons.
 * A mistake is reported before the round trip, with the offset and a caret
 * under it: the shared parser knows exactly where it gave up, and that
 * information does not survive being turned into an HTTP status. And the
 * compiled `filters` are understood by every server version, whereas a `query`
 * sent to a server that predates it would be ignored and quietly return
 * *unfiltered* spend, which is the one failure mode worth engineering against.
 *
 * The parser is imported dynamically, like the other client-core helpers the
 * CLI uses, so the CLI still takes no new runtime dependency.
 */
export async function parseWhere(where: string | undefined): Promise<CostFilter[]> {
  const text = where?.trim();
  if (!text) return [];
  const { parseCostQuery, CostQueryParseError } = await import("@infrawrench/client-core");
  try {
    return parseCostQuery(text);
  } catch (e) {
    if (e instanceof CostQueryParseError) {
      throw new CliError(`--where: ${e.annotated()}`, 2);
    }
    throw e;
  }
}

/**
 * `infrawrench costs tag-keys`: every tag key in the org's cost data, grouped
 * so Kubernetes node and volume labels read as labels. The values are what
 * `--group-by` and `--where` accept.
 */
export async function cmdCostTagKeys(ctx: CliContext): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError("Cost data lives in Infrawrench Cloud — there is no local cost history.");
  }
  const org = await resolveOrg(ctx);
  const res = await orgFetch<{ values: Array<string | { value: string }> }>(
    org.id,
    "/costs/dimensions?dimension=tag-keys",
  );
  const keys = (res.values ?? []).map((v) => (typeof v === "string" ? v : v.value));
  const { groupCostTagKeys, costTagAliasFor } = await import("@infrawrench/client-core");
  const groups = groupCostTagKeys(keys);

  if (ctx.flags.output === "json") {
    printJson({
      org: org.id,
      groups: groups.map((g) => ({
        group: g.group,
        keys: g.keys.map((k) => {
          const alias = costTagAliasFor(k.key);
          return {
            key: k.key,
            name: k.name,
            groupBy: alias ? `${alias.alias}:${alias.name}` : `tag:${k.key}`,
          };
        }),
      })),
    });
    return;
  }

  if (groups.length === 0) {
    println(c.dim("No tagged spend yet."));
    return;
  }
  const headings: Record<string, string> = {
    tag: "Tags",
    k8s: "Kubernetes",
    k8s_node_label: "Kubernetes node labels",
    k8s_pvc_label: "Kubernetes volume labels",
  };
  for (const g of groups) {
    println(c.bold(headings[g.group] ?? g.group));
    printTable(
      g.keys,
      [
        { header: "name", value: (k) => k.name },
        {
          header: "--group-by",
          value: (k) => {
            const alias = costTagAliasFor(k.key);
            return c.dim(alias ? `${alias.alias}:${alias.name}` : `tag:${k.key}`);
          },
        },
      ],
      { indent: 2 },
    );
    println();
  }
}

/**
 * `--filter <name|id>` → the saved filter it names, or null when the flag is
 * absent.
 *
 * Resolved to an *id* here and to rows on the server at query time: the same
 * reference semantics every graph and budget pointing at the filter gets. The
 * list is fetched once to match by id or (case-insensitive) name; names are
 * unique per org, so a name can never be ambiguous. An unknown value is an
 * error listing what exists, never a silent unfiltered query.
 */
export async function resolveSavedFilterFlag(
  orgId: string,
  flag: string | undefined,
): Promise<SavedCostFilter | null> {
  const wanted = flag?.trim();
  if (!wanted) return null;
  const saved = (await orgFetch<SavedCostFilter[]>(orgId, "/saved-cost-filters")) ?? [];
  const match =
    saved.find((f) => f.id === wanted) ??
    saved.find((f) => f.name.toLowerCase() === wanted.toLowerCase());
  if (!match) {
    const names = saved.map((f) => `"${f.name}"`).join(", ");
    throw new CliError(
      `--filter: no saved cost filter named "${wanted}".` +
        (saved.length > 0
          ? ` Saved filters: ${names}.`
          : " This organization has no saved filters yet — create one from any cost editor."),
      2,
    );
  }
  return match;
}

/**
 * Collection runs daily in the background and backs off on failure, so a
 * misconfigured provider reads as missing spend rather than an error. Fetch
 * the per-account state so the numbers below can be trusted (or explained).
 *
 * Three states are worth reporting: collection that failed, collection that
 * succeeded with nothing to show (a billing export that hasn't produced its
 * first rows yet) (both otherwise look like an account with no spend) and
 * spend that was computed here rather than billed by the provider, which looks
 * like nothing at all until someone reconciles it against an invoice.
 */
interface CollectionState {
  failing: CostAccountStatus[];
  empty: CostAccountStatus[];
  estimated: CostAccountStatus[];
  /** True when some account's plugin reports amortized cost at all. */
  amortizing: boolean;
  /** True when some account's plugin reports blended commitment discounts. */
  blending: boolean;
}

async function loadCollectionState(orgId: string): Promise<CollectionState> {
  const res = await orgFetch<{ accounts: CostAccountStatus[] }>(orgId, "/costs/status");
  const accounts = res.accounts ?? [];
  return {
    failing: accounts.filter((a) => a.supportsCosts && a.costPollError),
    empty: accounts.filter(
      (a) => a.supportsCosts && !a.costPollError && a.costLastPolledAt !== null && !a.coverage,
    ),
    estimated: accounts.filter((a) => a.supportsCosts && a.estimated),
    // `amortization` is optional on older servers' responses; absent reads as
    // "doesn't report one", which is what such a server was doing.
    amortizing: accounts.some((a) => a.supportsCosts && a.amortization),
    // Same posture for `blending`, which older servers never send.
    blending: accounts.some((a) => a.supportsCosts && a.blending === true),
  };
}

function printCollectionWarnings({ failing, empty, estimated }: CollectionState): void {
  for (const account of failing) {
    println(`${c.yellow("!")} ${c.bold(account.displayName)} ${c.dim("cost collection failing")}`);
    println(`  ${account.costPollError!.message}`);
    if (account.costPollError!.helpLink) {
      println(`  ${c.dim("→")} ${c.blue(account.costPollError!.helpLink.url)}`);
    }
  }
  for (const account of empty) {
    println(`${c.dim("·")} ${c.bold(account.displayName)} ${c.dim("no spend data yet")}`);
    println(`  ${c.dim("collected without error — the provider reported no spend")}`);
  }
  for (const account of estimated) {
    println(`${c.dim("·")} ${c.bold(account.displayName)} ${c.dim("spend is estimated")}`);
    println(
      `  ${c.dim("priced from current inventory at list rates — no billing API; runs low for anything deleted mid-period, and excludes credits, tax and refunds")}`,
    );
  }
  if (failing.length > 0 || empty.length > 0 || estimated.length > 0) println();
}

export async function cmdCosts(ctx: CliContext, range: RangeFlags): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError("Cost data lives in Infrawrench Cloud — there is no local cost history.");
  }
  const org = await resolveOrg(ctx);

  const parsedGroupBy = parseGroupByFlag(range.groupBy ?? "provider", GROUP_DIMENSIONS);
  if ("error" in parsedGroupBy) throw new CliError(parsedGroupBy.error);
  const groupBy = parsedGroupBy.groupBy;
  // Set only for a keyed dimension (`tag:env`, `virtual_tag:team`): the server
  // refuses a keyed grouping without one, and ignores it for any other.
  const groupByTagKey = KEYED_DIMENSIONS.includes(groupBy as KeyedCostDimensionId)
    ? parsedGroupBy.tagKey
    : undefined;

  const basis = parseBasis(range.basis);
  const chargeTypes = parseChargeTypes(range.chargeTypes);
  const displayCurrency = parseCurrency(range.currency);
  const filters = await parseWhere(range.where);
  const savedFilter = await resolveSavedFilterFlag(org.id, range.filter);
  const display = parseDisplayFlags(range);
  const binning = display.binning ?? "daily";
  const cumulative = display.cumulative === true;
  await checkDisplayFlags(org.id, {
    ...display,
    binning,
    groupBy: groupBy as CostQueryRequest["groupBy"],
  });

  const { from, to } = resolveDateRange(range);

  const query: CostQueryRequest = {
    from,
    to,
    binning,
    groupBy: groupBy as CostQueryRequest["groupBy"],
    ...(groupByTagKey ? { groupByTagKey } : {}),
    filters,
    topN: 8,
    comparePreviousPeriod: false,
    forecast: false,
    // Omitted when defaulted, so an older server that has never heard of either
    // field still answers the same request it always did.
    ...(basis ? { costBasis: basis } : {}),
    ...(chargeTypes.length > 0 ? { chargeTypes } : {}),
    // Omitted unless asked for, so a server that has never heard of conversion
    // (and an org that has not opted in) answers the request it always did.
    ...(displayCurrency ? { displayCurrency } : {}),
    // The *id*, resolved server-side at query time and AND-composed with the
    // --where filter above: the same reference semantics a graph or budget
    // pointing at this filter gets, so `--filter prod-only` cannot drift from
    // what "prod-only" means everywhere else.
    ...(savedFilter ? { savedFilterId: savedFilter.id } : {}),
    // The display options, each omitted unless given: same rule as above.
    ...(display.measure && display.measure !== "cost" ? { measure: display.measure } : {}),
    ...(display.usageUnit ? { usageUnit: display.usageUnit } : {}),
    ...(cumulative ? { cumulative: true } : {}),
  };

  const [response, collection] = await Promise.all([
    orgFetch<CostQueryResponse>(org.id, "/costs/query", {
      method: "POST",
      body: JSON.stringify(query),
    }),
    loadCollectionState(org.id),
  ]);

  if (ctx.flags.output === "json") {
    printJson({
      org: org.id,
      from,
      to,
      groupBy,
      groupByTagKey: groupByTagKey ?? null,
      // Echoed as both the text the user typed and the structure it compiled
      // to, so a script can see which filter actually ran without re-parsing.
      where: range.where?.trim() || null,
      filters,
      // The saved filter is echoed as id + name + the rows it resolved to at
      // request time, so a script can see the whole effective filter.
      savedFilter: savedFilter
        ? { id: savedFilter.id, name: savedFilter.name, filters: savedFilter.filters }
        : null,
      costBasis: basis ?? "cash",
      chargeTypes,
      // Echoed so a script can tell an unconverted run from a converted one
      // without inspecting `conversion`. `response.conversion` (spread below)
      // carries the rates applied and, crucially, the currencies that could
      // not be converted and are therefore outside the headline totals.
      displayCurrency: displayCurrency ?? null,
      // Echoed so a script knows whether the amounts below are money, a
      // quantity (and in which unit) or a count, and how they were binned.
      measure: display.measure ?? "cost",
      usageUnit: display.usageUnit ?? null,
      binning,
      cumulative,
      ...response,
      collectionFailures: collection.failing,
      awaitingData: collection.empty,
      // A script totalling this output has to be able to tell which accounts'
      // money was computed rather than billed.
      estimatedAccounts: collection.estimated,
    });
    return;
  }

  printCollectionWarnings(collection);
  printConversionNotice(response.conversion);

  const { series, totals } = response;
  if (series.length === 0) {
    println(c.dim("No cost data yet. Connect a provider account with billing access."));
    return;
  }

  const totalLine = Object.entries(totals)
    .map(([currency, amount]) => formatMeasureValue(amount, currency, response))
    .join(" + ");
  // The basis and any charge-type narrowing go in the header: a total that is
  // not the whole net bill must say so on the same line as the number, or it
  // gets quoted as if it were.
  const scope = [
    `${from} → ${to}`,
    // The filter belongs on the header line for the same reason the basis
    // does: a narrowed total that does not say what it excludes gets quoted as
    // if it were the whole bill.
    // The saved filter's name too: a total scoped by "prod only" that does
    // not say so gets quoted as the whole bill.
    ...(savedFilter ? [`filter "${savedFilter.name}"`] : []),
    ...(filters.length > 0 ? [range.where!.trim()] : []),
    ...(basis === "amortized" || basis === "blended" ? [basis] : []),
    ...(chargeTypes.length > 0 ? [chargeTypes.join(", ")] : []),
    // On the same line as the number, like the basis: a converted total that
    // does not say so gets quoted as if it were a collected one.
    ...(response.conversion && response.conversion.converted.length > 0
      ? [`converted to ${response.conversion.displayCurrency}`]
      : []),
    // A number with no currency sign must say what it is counting.
    ...(response.measure === "usage" ? [`usage in ${response.usageUnit ?? "?"}`] : []),
    ...(response.measure === "count" ? [`distinct ${groupBy} count`] : []),
    ...(cumulative ? ["cumulative"] : []),
  ].join(" · ");
  println(`${c.bold(org.displayName)} ${c.dim(`· ${scope}`)}  ${c.bold(totalLine)}`);
  if (basis === "amortized" && !collection.amortizing) {
    println(
      c.dim(
        "no connected provider reports amortized cost — these are the amounts you were charged",
      ),
    );
  }
  if (basis === "blended") {
    println(
      c.dim(
        collection.blending
          ? "blended: each commitment's discount shared evenly across all the usage it could cover; day totals match amortized"
          : "no connected provider reports blended commitment discounts, so these are the amortized amounts",
      ),
    );
  }
  println();

  // Daily total trend across all series (single-currency assumption per line).
  const byBucket = new Map<string, number>();
  for (const s of series) {
    for (const p of s.points) byBucket.set(p.bucket, (byBucket.get(p.bucket) ?? 0) + p.amount);
  }
  const buckets = [...byBucket.keys()].sort();
  const dailyTotals = buckets.map((b) => byBucket.get(b)!);
  const sparkWidth = Math.min(60, Math.max(20, buckets.length));
  println(`${c.dim(binning)} ${seriesColor(0)(sparkline(dailyTotals, sparkWidth))}`);
  println();

  const items = series.map((s, idx) => {
    const total = seriesTotal(s.points, cumulative);
    return {
      label: s.key === "__other__" ? c.dim("other") : s.label,
      value: total,
      display: formatMeasureValue(total, s.currency, response),
      colorIndex: idx,
    };
  });
  for (const line of barChart(items, 32)) println(line);
}

/* ------------------------------------------------------------------ *
 * `infrawrench costs --anomalies`
 * ------------------------------------------------------------------ */

/** The endpoint's own bound (`days` must be 1–90); checked before the request. */
export const MAX_ANOMALY_DAYS = 90;
const DEFAULT_ANOMALY_DAYS = 30;

export const DIMENSION_LABELS: Record<CostAnomaly["dimension"], string> = {
  provider: "provider",
  service: "service",
};

/**
 * Recent spend anomalies: days where one provider's or service's spend cleared
 * its own trailing baseline, and days where one started spending with no
 * history at all. Detection runs server-side after each cost collection, so
 * this is a read; the thresholds it uses are tuned from the Costs panel.
 */
export async function cmdCostAnomalies(ctx: CliContext, range: RangeFlags): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError(
      "Anomaly detection runs on Infrawrench Cloud over your org's collected spend — there is no local cost history.",
    );
  }
  const org = await resolveOrg(ctx);
  const days = resolveDayWindow(range, DEFAULT_ANOMALY_DAYS, MAX_ANOMALY_DAYS);

  const { anomalies } = await orgFetch<{ anomalies: CostAnomaly[] }>(
    org.id,
    `/costs/anomalies?days=${days}`,
  );

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, days, anomalies });
    return;
  }

  println(
    `${c.bold(org.displayName)} ${c.dim(`· spend anomalies, last ${days} day${days === 1 ? "" : "s"}`)}`,
  );
  println();

  if (anomalies.length === 0) {
    println(
      c.dim(
        "No anomalies. Each day's spend per provider and per service is compared against its own trailing 28-day baseline — nothing cleared the bar, and nothing started spending from scratch.",
      ),
    );
    return;
  }

  printTable(anomalies, [
    // Short ids: `costs --anomalies feedback <id>` accepts a unique prefix.
    { header: "id", value: (a) => c.dim(shortId(a.id)) },
    { header: "day", value: (a) => a.day },
    {
      header: "what spiked",
      value: (a) => {
        const what = `${c.bold(a.dimensionKey)} ${c.dim(DIMENSION_LABELS[a.dimension])}`;
        return a.kind === "new_source" ? `${what} ${c.yellow("[new source]")}` : what;
      },
    },
    {
      header: "actual",
      value: (a) => formatMoney(a.actualCents / 100, a.currency),
      align: "right",
    },
    {
      header: "baseline/day",
      // A new source has no baseline; printing "$0.00" invites the reader to
      // treat it as a measurement rather than an absence.
      value: (a) =>
        c.dim(a.kind === "new_source" ? "none" : formatMoney(a.baselineCents / 100, a.currency)),
      align: "right",
    },
    {
      header: "change",
      value: (a) => {
        const delta = anomalyDeltaPercent(a.actualCents, a.baselineCents, a.kind);
        return delta === null ? c.yellow("new") : c.red(delta);
      },
      align: "right",
    },
    {
      header: "notified",
      value: (a) => (a.notifiedAt ? c.dim(a.notifiedAt.slice(0, 10)) : c.dim("—")),
    },
    {
      // What somebody established this was, once they did. Truncated because a
      // table is not a place to read a paragraph; `--json` carries it whole.
      header: "explained",
      value: (a) => {
        const explanation = a.acknowledgement?.explanation;
        if (!explanation) return c.dim("—");
        return c.green(explanation.length > 44 ? `${explanation.slice(0, 43)}…` : explanation);
      },
    },
    {
      // The verdict somebody gave it, or that a suppression kept it quiet.
      header: "feedback",
      value: (a) => anomalyFeedbackLabel(a),
    },
  ]);

  println();
  println(
    c.dim(
      "Baseline is the trailing 28-day mean for that provider or service; a day clears the bar at mean + N standard deviations. Rows marked [new source] had no spend at all across that window and cleared an absolute floor instead. Both thresholds are per-org, tuned from the Costs panel. Un-notified rows were detected while no alert channel was connected, or inside another anomaly's cooldown. An explained row is one somebody has said the cause of; that sentence is also drawn as a note on every cost chart covering the day, and explaining a spike never stops the same key being flagged again.",
    ),
  );
  println(
    c.dim(
      "Tell detection whether a row was a real problem: infrawrench costs --anomalies feedback <id> --expected|--unexpected. A suppressed row matched a suppression somebody created, so it was recorded but did not alert.",
    ),
  );
}

/* ------------------------------------------------------------------ *
 * `infrawrench costs --alerts`
 * ------------------------------------------------------------------ */

/** How many recent firings the text listing shows; `--limit` overrides. */
const DEFAULT_ALERT_EVENTS = 20;
const MAX_ALERT_EVENTS = 200;

const CADENCE_WINDOWS: Record<CostAlert["cadence"], string> = {
  daily: "yesterday vs same day last week",
  weekly: "last 7 complete days vs prior 7",
  monthly: "month-to-date vs same days last month",
};

/** "+173%", "-42%", or "new" when the prior window had no spend at all. */
function alertDeltaLabel(event: CostAlertEvent): string {
  if (event.changePercent === null) return "new";
  return `${event.changePercent > 0 ? "+" : ""}${event.changePercent}%`;
}

/** The firing condition, compactly: "≥25% and ≥$100 up". */
function alertThresholdLabel(alert: CostAlert): string {
  const parts: string[] = [];
  if (alert.thresholdPercent !== null) parts.push(`≥${alert.thresholdPercent}%`);
  if (alert.thresholdAmountCents !== null) {
    parts.push(`≥${formatMoney(alert.thresholdAmountCents / 100, "USD")}`);
  }
  const direction =
    alert.direction === "both" ? "either way" : alert.direction === "increase" ? "up" : "down";
  return `${parts.join(" and ")} ${direction}`;
}

/**
 * Change-based cost alerts and their recent firings; the third cost-alert
 * family alongside budgets (absolute monthly total) and anomalies
 * (statistical outliers): a configured "spend on this scope moved more than
 * X% (or $Y) versus the prior period". Evaluation runs server-side after
 * each cost collection; alerts are managed from the Costs panel.
 */
export async function cmdCostAlerts(ctx: CliContext, range: RangeFlags): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError(
      "Change alerts evaluate on Infrawrench Cloud over your org's collected spend — there is no local cost history.",
    );
  }
  const org = await resolveOrg(ctx);
  const limit = Math.min(range.limit ?? DEFAULT_ALERT_EVENTS, MAX_ALERT_EVENTS);

  const [{ alerts }, { events }] = await Promise.all([
    orgFetch<{ alerts: CostAlert[] }>(org.id, "/cost-alerts"),
    orgFetch<{ events: CostAlertEvent[] }>(org.id, `/cost-alerts/events?limit=${limit}`),
  ]);

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, alerts, events });
    return;
  }

  println(`${c.bold(org.displayName)} ${c.dim("· change-based cost alerts")}`);
  println();

  if (alerts.length === 0) {
    println(
      c.dim(
        "No change alerts. A change alert fires when spend on a scope you choose moves more than a threshold you choose versus the prior period — distinct from budgets (an absolute monthly total) and anomaly detection (statistical outliers). Create one from the Costs panel.",
      ),
    );
    return;
  }

  printTable(alerts, [
    {
      header: "name",
      value: (a) => (a.enabled ? c.bold(a.name) : `${c.bold(a.name)} ${c.dim("[paused]")}`),
    },
    { header: "cadence", value: (a) => c.dim(CADENCE_WINDOWS[a.cadence]) },
    { header: "fires when", value: (a) => alertThresholdLabel(a) },
    {
      header: "watching",
      value: (a) =>
        c.dim(
          `${formatGroupBy(a.groupBy, a.groupByTagKey)}${a.filters.length > 0 ? ` · ${a.filters.length} filter${a.filters.length === 1 ? "" : "s"}` : ""}`,
        ),
    },
    {
      header: "last fired",
      value: (a) => c.dim(a.lastFiredAt ? a.lastFiredAt.slice(0, 10) : "never"),
    },
  ]);

  println();
  if (events.length === 0) {
    println(c.dim("No firings yet."));
    return;
  }

  println(c.dim(`recent firings (newest first, up to ${limit})`));
  printTable(events, [
    { header: "fired", value: (e) => e.firedAt.slice(0, 10) },
    {
      header: "alert",
      value: (e) =>
        e.groupKey === ""
          ? c.bold(e.alertName)
          : `${c.bold(e.alertName)} ${c.dim(`· ${e.groupKey}`)}`,
    },
    {
      header: "window",
      value: (e) =>
        c.dim(e.windowFrom === e.windowTo ? e.windowTo : `${e.windowFrom}..${e.windowTo}`),
    },
    {
      header: "previous",
      value: (e) => c.dim(formatMoney(e.previousAmountCents / 100, e.currency)),
      align: "right",
    },
    {
      header: "current",
      value: (e) => formatMoney(e.currentAmountCents / 100, e.currency),
      align: "right",
    },
    {
      header: "change",
      value: (e) => {
        const label = alertDeltaLabel(e);
        if (e.changePercent === null) return c.yellow(label);
        return e.direction === "increase" ? c.red(label) : c.green(label);
      },
      align: "right",
    },
  ]);

  println();
  println(
    c.dim(
      "Windows are complete UTC days: daily compares one day to the same weekday a week earlier, weekly the last 7 complete days to the prior 7, monthly the month-to-date to the same number of days at the start of last month. Each cadence period fires at most once per watched group and currency; 'new' means the prior window had no spend at all.",
    ),
  );
}
