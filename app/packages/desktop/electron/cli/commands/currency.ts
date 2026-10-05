// `infrawrench currency`: the org's display currency, the rates it has stated,
// and the automatic ECB reference-rate feed.
//
// Worth a terminal command because "which rate made this number?" is the first
// question anyone reconciling a converted total asks, and `currency rate EUR
// 2026-09-30` answers it with the org's own precedence applied (a stated rate
// first, then the feed) and a sentence saying why. Read-only on purpose:
// stating a rate restates every historical total the org reports, which rides
// `org:settings:write` and an audit entry, not a shell one-liner.
//
// Types are imported type-only from `@infrawrench/client-core` with the
// resolution-mode attribute, so the CLI ships zero runtime dependencies.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  ExchangeRate,
  ExchangeRateLookup,
  FxFeedStatus,
  OrgCurrencyConfig,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { c, printJson, println, printTable, type Column } from "../output";

const CODE = /^[A-Z]{3}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function requireCloud(ctx: CliContext): void {
  if (ctx.flags.local) {
    throw new CliError(
      "Currency settings live in Infrawrench Cloud: conversion applies to collected spend, " +
        "which a local-only workspace does not have.",
    );
  }
}

function feedLine(feed: FxFeedStatus): string {
  if (!feed.latestRateDate) return "no reference rates fetched yet";
  return `latest publication ${feed.latestRateDate}, history from ${feed.earliestRateDate ?? "?"}`;
}

/** `infrawrench currency`: settings, stated rates, feed state. */
export async function cmdCurrency(ctx: CliContext): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  const config = await orgFetch<OrgCurrencyConfig>(org.id, "/currency");

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...config });
    return;
  }

  println(
    `${c.bold(org.displayName)} ${c.dim("·")} display currency ${
      config.displayCurrency ? c.bold(config.displayCurrency) : c.dim("none (conversion off)")
    }`,
  );
  println(
    `  automatic rates ${config.autoRates ? c.green("on") : c.dim("off")} ${c.dim(
      `· basis ${config.rateBasis === "month_end" ? "end-of-month rate" : "daily rate"}`,
    )}`,
  );
  println(`  ${c.dim(`ECB feed: ${feedLine(config.feed)}`)}`);
  if (config.feed.lastError) {
    println(`  ${c.yellow("!")} ${c.dim(`last fetch failed: ${config.feed.lastError}`)}`);
  }
  if (config.feed.currencies.length > 0) {
    println(
      `  ${c.dim(`covered: ${config.feed.currencies.join(", ")}; anything else is manual-only`)}`,
    );
  }
  println();

  if (config.rates.length === 0) {
    println(c.dim("No stated rates."));
  } else {
    const columns: Column<ExchangeRate>[] = [
      { header: "from", value: (r) => r.fromCurrency },
      { header: "to", value: (r) => r.toCurrency },
      { header: "rate", value: (r) => r.rate, align: "right" },
      { header: "from date", value: (r) => r.effectiveFrom },
      { header: "until", value: (r) => r.effectiveTo ?? c.dim("open-ended") },
    ];
    printTable(config.rates, columns);
  }
  println();
  println(
    c.dim(
      "A stated rate always wins over an automatic one for the days it covers. " +
        "`infrawrench currency rate <FROM> [TO] [YYYY-MM-DD]` shows which rate a day converts at.",
    ),
  );
}

/** `infrawrench currency rate <FROM> [TO] [DATE]`: the rate a day converts at, and why. */
export async function cmdCurrencyRate(ctx: CliContext, args: string[]): Promise<void> {
  requireCloud(ctx);
  const codes = args.filter((a) => CODE.test(a.toUpperCase()) && !ISO_DAY.test(a));
  const date = args.find((a) => ISO_DAY.test(a));
  const unknown = args.filter((a) => !CODE.test(a.toUpperCase()) && !ISO_DAY.test(a));
  if (codes.length === 0 || codes.length > 2 || unknown.length > 0) {
    throw new CliError("Usage: infrawrench currency rate <FROM> [TO] [YYYY-MM-DD]", 2);
  }
  const org = await resolveOrg(ctx);
  const params = new URLSearchParams({ from: codes[0]!.toUpperCase() });
  if (codes[1]) params.set("to", codes[1].toUpperCase());
  if (date) params.set("date", date);
  const lookup = await orgFetch<ExchangeRateLookup>(org.id, `/currency/lookup?${params}`);

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...lookup });
    return;
  }
  const head = `${lookup.fromCurrency} → ${lookup.toCurrency} on ${lookup.date}`;
  if (lookup.rate === null) {
    println(`${c.bold(head)} ${c.yellow("no rate")}`);
  } else {
    const source = lookup.source === "ecb" ? "ECB reference rate" : "your stated rate";
    println(`${c.bold(head)} ${lookup.rate} ${c.dim(`(${source}, ${lookup.rateDate})`)}`);
  }
  println(c.dim(lookup.explanation));
}

interface FeedRates extends FxFeedStatus {
  date: string;
  base: string;
  rateDate: string | null;
  rates: Array<{ currency: string; rate: number }>;
}

/** `infrawrench currency feed [DATE] [--currency BASE]`: the ECB rates for a day. */
export async function cmdCurrencyFeed(
  ctx: CliContext,
  args: string[],
  base: string | undefined,
): Promise<void> {
  requireCloud(ctx);
  const date = args.find((a) => ISO_DAY.test(a));
  if (args.some((a) => !ISO_DAY.test(a))) {
    throw new CliError("Usage: infrawrench currency feed [YYYY-MM-DD] [--currency USD]", 2);
  }
  if (base !== undefined && !CODE.test(base.toUpperCase())) {
    throw new CliError(`--currency must be a three-letter code like USD (got "${base}").`, 2);
  }
  const org = await resolveOrg(ctx);
  const params = new URLSearchParams();
  if (date) params.set("date", date);
  if (base) params.set("base", base.toUpperCase());
  const feed = await orgFetch<FeedRates>(org.id, `/currency/feed?${params}`);

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...feed });
    return;
  }
  if (!feed.rateDate) {
    println(c.dim(`The ECB feed has no rates on or before ${feed.date}.`));
    return;
  }
  println(
    `${c.bold(`ECB reference rates in ${feed.base}`)} ${c.dim(
      `for ${feed.date}${feed.rateDate !== feed.date ? ` (carried from ${feed.rateDate})` : ""}`,
    )}`,
  );
  println();
  printTable(feed.rates, [
    { header: "currency", value: (r) => r.currency },
    { header: `1 unit in ${feed.base}`, value: (r) => String(r.rate), align: "right" },
  ]);
}
