// `infrawrench costs` — org cost graphs in the terminal, backed by the same
// /costs/query API the web + desktop dashboards use.
//
// The request/response shapes come from `@infrawrench/client-core` — the same
// definitions the web, desktop, and mobile cost views describe the wire with,
// so a server-side change breaks the CLI's build instead of its output. The
// import is type-only, so the CLI still ships zero new runtime dependencies.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  CostAccountStatus,
  CostAnomaly,
  CostBasis,
  CostChargeType,
  CostConversion,
  CostFilter,
  CostQueryRequest,
  CostQueryResponse,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import type { RangeFlags } from "../args";
import { parseLastDays, resolveDayWindow } from "../args";
import { c, printJson, println, printTable, formatMoney, seriesColor } from "../output";
import { anomalyDeltaPercent } from "../format";
import { barChart, sparkline } from "../charts";

const GROUP_DIMENSIONS = [
  "provider",
  "account",
  "service",
  "region",
  "resource",
  "charge_type",
  "commitment",
] as const;

/**
 * The two money bases and the charge types, restated as plain arrays.
 *
 * The wire types above are imported type-only so the CLI keeps its zero runtime
 * dependencies; a `const` from client-core would be a real import. Drift is
 * caught at build time anyway — the values are assigned to the imported types
 * below, so removing a charge type upstream fails this file's typecheck.
 */
const COST_BASES: readonly CostBasis[] = ["cash", "amortized"];
const CHARGE_TYPES: readonly CostChargeType[] = [
  "usage",
  "commitment_fee",
  "commitment_discount",
  "credit",
  "tax",
  "refund",
  "adjustment",
  "support",
  "other",
];

/**
 * `--currency USD` — the display currency to convert into.
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
 * must never be dropped — a currency with no rate is shown separately, so the
 * big number is not the whole spend and the reader has to be told.
 */
function printConversionNotice(conversion: CostConversion | undefined): void {
  if (!conversion) return;
  const { displayCurrency, converted, unconverted } = conversion;
  if (converted.length === 0 && unconverted.length === 0) return;

  for (const entry of converted) {
    const rates = entry.rates.map((r) => `${r.rate} from ${r.effectiveFrom}`).join(", ");
    println(
      `${c.dim("·")} ${c.bold(entry.currency)} ${c.dim(`converted to ${displayCurrency} at ${rates}`)}`,
    );
  }
  if (converted.length > 0) {
    println(
      `  ${c.dim("your organization's own stated rates — Infrawrench never fetches live FX; spend already in " + displayCurrency + " is not converted")}`,
    );
  }
  if (unconverted.length > 0) {
    println(
      `${c.yellow("!")} ${c.bold(unconverted.join(", "))} ${c.dim(`not included in the ${displayCurrency} figure`)}`,
    );
    println(
      `  ${c.dim("no exchange rate is configured (or none covers every day in this range), so these amounts are listed separately in their own currency rather than folded in or dropped")}`,
    );
  }
  println();
}

/** `--basis cash|amortized`, defaulting to cash. */
function parseBasis(raw: string | undefined): CostBasis | undefined {
  if (raw === undefined) return undefined;
  const match = COST_BASES.find((b) => b === raw);
  if (!match) {
    throw new CliError(`--basis must be one of ${COST_BASES.join(", ")} — got "${raw}".`, 2);
  }
  return match;
}

/** Repeated `--charge-type`; empty means every kind, i.e. a net total. */
function parseChargeTypes(raw: string[] | undefined): CostChargeType[] {
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
 * under it — the shared parser knows exactly where it gave up, and that
 * information does not survive being turned into an HTTP status. And the
 * compiled `filters` are understood by every server version, whereas a `query`
 * sent to a server that predates it would be ignored and quietly return
 * *unfiltered* spend, which is the one failure mode worth engineering against.
 *
 * The parser is imported dynamically, like the other client-core helpers the
 * CLI uses, so the CLI still takes no new runtime dependency.
 */
async function parseWhere(where: string | undefined): Promise<CostFilter[]> {
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
 * Collection runs daily in the background and backs off on failure, so a
 * misconfigured provider reads as missing spend rather than an error. Fetch
 * the per-account state so the numbers below can be trusted (or explained).
 *
 * Three states are worth reporting: collection that failed, collection that
 * succeeded with nothing to show (a billing export that hasn't produced its
 * first rows yet) — both otherwise look like an account with no spend — and
 * spend that was computed here rather than billed by the provider, which looks
 * like nothing at all until someone reconciles it against an invoice.
 */
interface CollectionState {
  failing: CostAccountStatus[];
  empty: CostAccountStatus[];
  estimated: CostAccountStatus[];
  /** True when some account's plugin reports amortized cost at all. */
  amortizing: boolean;
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

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function cmdCosts(ctx: CliContext, range: RangeFlags): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError("Cost data lives in Infrawrench Cloud — there is no local cost history.");
  }
  const org = await resolveOrg(ctx);

  const groupBy = range.groupBy ?? "provider";
  if (groupBy !== "none" && !GROUP_DIMENSIONS.includes(groupBy as never)) {
    throw new CliError(
      `--group-by must be one of none, ${GROUP_DIMENSIONS.join(", ")} — got "${groupBy}".`,
    );
  }

  const basis = parseBasis(range.basis);
  const chargeTypes = parseChargeTypes(range.chargeTypes);
  const displayCurrency = parseCurrency(range.currency);
  const filters = await parseWhere(range.where);

  const days = range.last ? Math.max(1, Math.round(parseLastDays(range.last))) : 30;
  const to = range.to ?? isoDay(Date.now());
  const from = range.from ?? isoDay(Date.parse(to) - (days - 1) * 86_400_000);

  const query: CostQueryRequest = {
    from,
    to,
    binning: "daily",
    groupBy: groupBy as CostQueryRequest["groupBy"],
    filters,
    topN: 8,
    comparePreviousPeriod: false,
    forecast: false,
    // Omitted when defaulted, so an older server that has never heard of either
    // field still answers the same request it always did.
    ...(basis ? { costBasis: basis } : {}),
    ...(chargeTypes.length > 0 ? { chargeTypes } : {}),
    // Omitted unless asked for, so a server that has never heard of conversion
    // — and an org that has not opted in — answers the request it always did.
    ...(displayCurrency ? { displayCurrency } : {}),
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
      // Echoed as both the text the user typed and the structure it compiled
      // to, so a script can see which filter actually ran without re-parsing.
      where: range.where?.trim() || null,
      filters,
      costBasis: basis ?? "cash",
      chargeTypes,
      // Echoed so a script can tell an unconverted run from a converted one
      // without inspecting `conversion`. `response.conversion` (spread below)
      // carries the rates applied and, crucially, the currencies that could
      // not be converted and are therefore outside the headline totals.
      displayCurrency: displayCurrency ?? null,
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
    .map(([currency, amount]) => formatMoney(amount, currency))
    .join(" + ");
  // The basis and any charge-type narrowing go in the header: a total that is
  // not the whole net bill must say so on the same line as the number, or it
  // gets quoted as if it were.
  const scope = [
    `${from} → ${to}`,
    // The filter belongs on the header line for the same reason the basis
    // does: a narrowed total that does not say what it excludes gets quoted as
    // if it were the whole bill.
    ...(filters.length > 0 ? [range.where!.trim()] : []),
    ...(basis === "amortized" ? ["amortized"] : []),
    ...(chargeTypes.length > 0 ? [chargeTypes.join(", ")] : []),
    // On the same line as the number, like the basis: a converted total that
    // does not say so gets quoted as if it were a collected one.
    ...(response.conversion && response.conversion.converted.length > 0
      ? [`converted to ${response.conversion.displayCurrency}`]
      : []),
  ].join(" · ");
  println(`${c.bold(org.displayName)} ${c.dim(`· ${scope}`)}  ${c.bold(totalLine)}`);
  if (basis === "amortized" && !collection.amortizing) {
    println(
      c.dim(
        "no connected provider reports amortized cost — these are the amounts you were charged",
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
  println(`${c.dim("daily")} ${seriesColor(0)(sparkline(dailyTotals, sparkWidth))}`);
  println();

  const items = series.map((s, idx) => {
    const total = s.points.reduce((sum, p) => sum + p.amount, 0);
    return {
      label: s.key === "__other__" ? c.dim("other") : s.label,
      value: total,
      display: formatMoney(total, s.currency),
      colorIndex: idx,
    };
  });
  for (const line of barChart(items, 32)) println(line);
}

/* ------------------------------------------------------------------ *
 * `infrawrench costs --anomalies`
 * ------------------------------------------------------------------ */

/** The endpoint's own bound (`days` must be 1–90); checked before the request. */
const MAX_ANOMALY_DAYS = 90;
const DEFAULT_ANOMALY_DAYS = 30;

const DIMENSION_LABELS: Record<CostAnomaly["dimension"], string> = {
  provider: "provider",
  service: "service",
};

/**
 * Recent spend anomalies — days where one provider's or service's spend cleared
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
  ]);

  println();
  println(
    c.dim(
      "Baseline is the trailing 28-day mean for that provider or service; a day clears the bar at mean + N standard deviations. Rows marked [new source] had no spend at all across that window and cleared an absolute floor instead. Both thresholds are per-org, tuned from the Costs panel. Un-notified rows were detected while no alert channel was connected, or inside another anomaly's cooldown.",
    ),
  );
}
