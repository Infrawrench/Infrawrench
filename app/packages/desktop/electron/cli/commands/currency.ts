// `infrawrench currency`: the org's display currency, the rates it has stated,
// and the automatic ECB reference-rate feed.
//
// Worth a terminal command because "which rate made this number?" is the first
// question anyone reconciling a converted total asks, and `currency rate EUR
// 2026-09-30` answers it with the org's own precedence applied (a stated rate
// first, then the feed) and a sentence saying why. Single rates are not
// written from here: stating a rate restates every historical total the org
// reports, which rides `org:settings:write` and an audit entry. The one write
// is `currency import`, a whole file of rates a finance system produced, and
// it always shows the server's preview of every row before anything lands.
//
// Types are imported type-only from `@infrawrench/client-core` with the
// resolution-mode attribute, so the CLI ships zero runtime dependencies.
import { readFile } from "node:fs/promises";
import { CliError, orgFetch, orgFetchText, resolveOrg, type CliContext } from "../context";
import type {
  ExchangeRate,
  ExchangeRateImportResult,
  ExchangeRateLookup,
  FxFeedStatus,
  OrgCurrencyConfig,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { c, printJson, println, printTable, type Column } from "../output";
import { confirm } from "../prompt";

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

/** `infrawrench currency template`: the CSV an upload reads, on stdout. */
export async function cmdCurrencyTemplate(ctx: CliContext): Promise<void> {
  requireCloud(ctx);
  const org = await resolveOrg(ctx);
  process.stdout.write(await orgFetchText(org.id, "/currency/rates/template"));
}

/**
 * `infrawrench currency import <file.csv> [--skip-invalid] [-y]`: upload many
 * stated rates.
 *
 * Always previews first (a server-side dry run that classifies every row
 * against the stored table), then asks before writing; `-y` skips the question
 * and is the only way to apply from a non-interactive shell, so a script has
 * to say so. A file with invalid rows writes nothing unless `--skip-invalid`.
 */
export async function cmdCurrencyImport(
  ctx: CliContext,
  args: string[],
  flags: { skipInvalid: boolean; yes: boolean },
): Promise<void> {
  requireCloud(ctx);
  const path = args[0];
  if (!path || args.length > 1) {
    throw new CliError("Usage: infrawrench currency import <file.csv> [--skip-invalid] [-y]", 2);
  }
  let csv: string;
  try {
    csv = await readFile(path, "utf8");
  } catch (e) {
    throw new CliError(`Couldn't read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const org = await resolveOrg(ctx);
  const send = (body: { csv: string; dryRun?: boolean; skipInvalid?: boolean }) =>
    orgFetch<ExchangeRateImportResult>(org.id, "/currency/rates/import", {
      method: "POST",
      body: JSON.stringify(body),
    });

  const preview = await send({ csv, dryRun: true });
  const writable = preview.counts.create + preview.counts.update;
  const json = ctx.flags.output === "json";
  if (!json) printImportResult(preview);

  const blocked = preview.counts.error > 0 && !flags.skipInvalid;
  if (writable === 0 || blocked) {
    if (json) printJson({ org: org.id, ...preview });
    else if (blocked) {
      println(
        c.yellow(
          "Nothing written: fix the rows above, or pass --skip-invalid to import the valid ones.",
        ),
      );
    } else println(c.dim("Nothing to write: every rate in the file is already stored."));
    if (blocked) process.exitCode = 1;
    return;
  }
  if (!flags.yes) {
    if (!process.stdin.isTTY || json) {
      if (json) printJson({ org: org.id, ...preview });
      else println(c.dim("Preview only. Re-run with -y to write these rates."));
      return;
    }
    if (!(await confirm(`Write ${writable} rate${writable === 1 ? "" : "s"}?`))) return;
  }
  const result = await send({ csv, skipInvalid: flags.skipInvalid });
  if (json) {
    printJson({ org: org.id, ...result });
    return;
  }
  println(
    c.green(
      `Imported: ${result.counts.create} new, ${result.counts.update} replaced, ` +
        `${result.counts.unchanged} unchanged${result.counts.error ? `, ${result.counts.error} skipped` : ""}.`,
    ),
  );
}

function printImportResult(result: ExchangeRateImportResult): void {
  const label: Record<ExchangeRateImportResult["rows"][number]["action"], string> = {
    create: c.green("new"),
    update: c.yellow("replaces"),
    unchanged: c.dim("unchanged"),
    error: c.red("error"),
  };
  printTable(result.rows, [
    { header: "line", value: (r) => String(r.line), align: "right" },
    {
      header: "rate",
      value: (r) =>
        r.rate ? `1 ${r.rate.fromCurrency} = ${r.rate.rate} ${r.rate.toCurrency}` : "",
    },
    {
      header: "effective",
      value: (r) =>
        r.rate
          ? `${r.rate.effectiveFrom}${r.rate.effectiveTo ? ` to ${r.rate.effectiveTo}` : ""}`
          : "",
    },
    {
      header: "result",
      value: (r) =>
        `${label[r.action]}${r.previousRate ? c.dim(` (was ${r.previousRate})`) : ""}${
          r.error ? ` ${r.error}` : ""
        }`,
    },
  ]);
  println();
  println(
    `${result.counts.create} new, ${result.counts.update} replace a stored rate, ` +
      `${result.counts.unchanged} unchanged, ${result.counts.error} with errors`,
  );
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
