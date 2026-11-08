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
import { Effect, Option, Schema } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import type {
  ExchangeRateImportResult,
  ExchangeRateLookup,
  FxFeedStatus,
  OrgCurrencyConfig,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliExit, CliFailure, CliUsageError } from "../effect/errors";
import * as Print from "../effect/print";
import { currency } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { spreadBody, wire } from "../effect/wire";
import { c, safe, type Column } from "../output";
import { confirm } from "../effect/prompt";

const CODE = /^[A-Z]{3}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const requireCloud = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message:
        "Currency settings live in Infrawrench Cloud: conversion applies to collected spend, " +
        "which a local-only workspace does not have.",
    });
  }
});

const Feed = Schema.Struct({
  latestRateDate: Schema.NullOr(Schema.String),
  earliestRateDate: Schema.NullOr(Schema.String),
  currencies: Schema.Array(Schema.String),
  lastError: Schema.NullOr(Schema.String),
});

const Rate = Schema.Struct({
  fromCurrency: Schema.String,
  toCurrency: Schema.String,
  rate: Schema.String,
  effectiveFrom: Schema.String,
  effectiveTo: Schema.NullOr(Schema.String),
});
type Rate = typeof Rate.Type;

const Config = wire<OrgCurrencyConfig>()(
  Schema.Struct({
    displayCurrency: Schema.NullOr(Schema.String),
    autoRates: Schema.Boolean,
    rateBasis: Schema.String,
    feed: Feed,
    rates: Schema.Array(Rate),
  }),
);

const Lookup = wire<ExchangeRateLookup>()(
  Schema.Struct({
    fromCurrency: Schema.String,
    toCurrency: Schema.String,
    date: Schema.String,
    rate: Schema.NullOr(Schema.Finite),
    source: Schema.NullOr(Schema.String),
    rateDate: Schema.NullOr(Schema.String),
    explanation: Schema.String,
  }),
);

const ImportResult = wire<ExchangeRateImportResult>()(
  Schema.Struct({
    rows: Schema.Array(
      Schema.Struct({
        line: Schema.Finite,
        action: Schema.String,
        rate: Schema.optional(
          Schema.Struct({
            fromCurrency: Schema.String,
            toCurrency: Schema.String,
            rate: Schema.String,
            effectiveFrom: Schema.String,
            effectiveTo: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
        previousRate: Schema.optional(Schema.String),
        error: Schema.optional(Schema.String),
      }),
    ),
    counts: Schema.Struct({
      create: Schema.Finite,
      update: Schema.Finite,
      unchanged: Schema.Finite,
      error: Schema.Finite,
    }),
  }),
);
type ImportResult = typeof ImportResult.Type;

/** `GET /currency/feed`: the feed's state plus the rates for one day. */
const FeedRates = wire<
  FxFeedStatus & {
    date: string;
    base: string;
    rateDate: string | null;
    rates: Array<{ currency: string; rate: number }>;
  }
>()(
  Schema.Struct({
    date: Schema.String,
    base: Schema.String,
    rateDate: Schema.NullOr(Schema.String),
    rates: Schema.Array(Schema.Struct({ currency: Schema.String, rate: Schema.Finite })),
  }),
);

function feedLine(feed: typeof Feed.Type): string {
  if (!feed.latestRateDate) return "no reference rates fetched yet";
  return `latest publication ${feed.latestRateDate}, history from ${feed.earliestRateDate ?? "?"}`;
}

/** `infrawrench currency`: settings, stated rates, feed state. */
const overview = Effect.fn("currency")(function* () {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  yield* requireCloud;
  const org = yield* currentOrg;
  const path = "/currency";
  const body = yield* api.json(org.id, path);

  if (session.output === "json") {
    return yield* Print.json(yield* spreadBody({ org: org.id }, body, path));
  }
  const config = yield* decodeBody(Config, path)(body);

  yield* Print.line(
    `${c.bold(safe(org.displayName))} ${c.dim("·")} display currency ${
      config.displayCurrency ? c.bold(safe(config.displayCurrency)) : c.dim("none (conversion off)")
    }`,
  );
  yield* Print.line(
    `  automatic rates ${config.autoRates ? c.green("on") : c.dim("off")} ${c.dim(
      `· basis ${config.rateBasis === "month_end" ? "end-of-month rate" : "daily rate"}`,
    )}`,
  );
  yield* Print.line(`  ${c.dim(`ECB feed: ${feedLine(config.feed)}`)}`);
  if (config.feed.lastError) {
    yield* Print.line(
      `  ${c.yellow("!")} ${c.dim(`last fetch failed: ${safe(config.feed.lastError)}`)}`,
    );
  }
  if (config.feed.currencies.length > 0) {
    yield* Print.line(
      `  ${c.dim(`covered: ${config.feed.currencies.join(", ")}; anything else is manual-only`)}`,
    );
  }
  yield* Print.line();

  if (config.rates.length === 0) {
    yield* Print.line(c.dim("No stated rates."));
  } else {
    const columns: Column<Rate>[] = [
      { header: "from", value: (r) => safe(r.fromCurrency) },
      { header: "to", value: (r) => safe(r.toCurrency) },
      { header: "rate", value: (r) => safe(r.rate), align: "right" },
      { header: "from date", value: (r) => r.effectiveFrom },
      { header: "until", value: (r) => r.effectiveTo ?? c.dim("open-ended") },
    ];
    yield* Print.table(config.rates, columns);
  }
  yield* Print.line();
  yield* Print.line(
    c.dim(
      "A stated rate always wins over an automatic one for the days it covers. " +
        "`infrawrench currency rate <FROM> [TO] [YYYY-MM-DD]` shows which rate a day converts at.",
    ),
  );
});

/** `infrawrench currency rate <FROM> [TO] [DATE]`: the rate a day converts at, and why. */
const rate = Command.make(
  "rate",
  {
    args: Argument.String("FROM [TO] [YYYY-MM-DD]").pipe(
      Argument.withDescription("A currency, optionally a second one and a day"),
      Argument.variadic(),
    ),
  },
  Effect.fn("currency.rate")(function* ({ args }) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    yield* requireCloud;
    const codes = args.filter((a) => CODE.test(a.toUpperCase()) && !ISO_DAY.test(a));
    const date = args.find((a) => ISO_DAY.test(a));
    const unknown = args.filter((a) => !CODE.test(a.toUpperCase()) && !ISO_DAY.test(a));
    const [first, second] = codes;
    if (!first || codes.length > 2 || unknown.length > 0) {
      return yield* new CliUsageError({
        message: "Usage: infrawrench currency rate <FROM> [TO] [YYYY-MM-DD]",
      });
    }
    const org = yield* currentOrg;
    const params = new URLSearchParams({ from: first.toUpperCase() });
    if (second) params.set("to", second.toUpperCase());
    if (date) params.set("date", date);
    const path = `/currency/lookup?${params}`;
    const body = yield* api.json(org.id, path);

    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, path));
    }
    const lookup = yield* decodeBody(Lookup, path)(body);
    const head = safe(`${lookup.fromCurrency} → ${lookup.toCurrency} on ${lookup.date}`);
    if (lookup.rate === null) {
      yield* Print.line(`${c.bold(head)} ${c.yellow("no rate")}`);
    } else {
      const source = lookup.source === "ecb" ? "ECB reference rate" : "your stated rate";
      yield* Print.line(
        `${c.bold(head)} ${lookup.rate} ${c.dim(`(${source}, ${lookup.rateDate})`)}`,
      );
    }
    yield* Print.line(c.dim(safe(lookup.explanation)));
  }),
).pipe(Command.withDescription("The rate a day of spend converts at, its source and why"));

/** `infrawrench currency feed [DATE] [--currency BASE]`: the ECB rates for a day. */
const feed = Command.make(
  "feed",
  {
    args: Argument.String("YYYY-MM-DD").pipe(
      Argument.withDescription("The day (default: the latest publication)"),
      Argument.variadic(),
    ),
    base: currency.pipe(
      Flag.withDescription("Express the rates in this currency"),
      Flag.mapEffect((value) =>
        Option.isSome(value) && !CODE.test(value.value.toUpperCase())
          ? Effect.fail(
              new CliError.ValidationError({
                message: `--currency must be a three-letter code like USD (got "${value.value}").`,
              }),
            )
          : Effect.succeed(value),
      ),
    ),
  },
  Effect.fn("currency.feed")(function* ({ args, base }) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    yield* requireCloud;
    const date = args.find((a) => ISO_DAY.test(a));
    if (args.some((a) => !ISO_DAY.test(a))) {
      return yield* new CliUsageError({
        message: "Usage: infrawrench currency feed [YYYY-MM-DD] [--currency USD]",
      });
    }
    const org = yield* currentOrg;
    const params = new URLSearchParams();
    if (date) params.set("date", date);
    if (Option.isSome(base) && base.value) params.set("base", base.value.toUpperCase());
    const path = `/currency/feed?${params}`;
    const body = yield* api.json(org.id, path);

    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, path));
    }
    const rates = yield* decodeBody(FeedRates, path)(body);
    if (!rates.rateDate) {
      return yield* Print.line(c.dim(`The ECB feed has no rates on or before ${rates.date}.`));
    }
    yield* Print.line(
      `${c.bold(`ECB reference rates in ${safe(rates.base)}`)} ${c.dim(
        `for ${rates.date}${rates.rateDate !== rates.date ? ` (carried from ${rates.rateDate})` : ""}`,
      )}`,
    );
    yield* Print.line();
    yield* Print.table(rates.rates, [
      { header: "currency", value: (r) => safe(r.currency) },
      { header: `1 unit in ${safe(rates.base)}`, value: (r) => String(r.rate), align: "right" },
    ]);
  }),
).pipe(Command.withDescription("The ECB reference rates for a day"));

/** `infrawrench currency template`: the CSV an upload reads, on stdout. */
const template = Command.make(
  "template",
  {},
  Effect.fn("currency.template")(function* () {
    const api = yield* CloudApi;
    yield* requireCloud;
    const org = yield* currentOrg;
    yield* Print.write(yield* api.text(org.id, "/currency/rates/template"));
  }),
).pipe(Command.withDescription("The CSV template an import reads, on stdout"));

const printImportResult = Effect.fnUntraced(function* (result: ImportResult) {
  // Built per call: the colours follow `--no-color`, applied after this
  // module loads.
  const labels: Partial<Record<string, string>> = {
    create: c.green("new"),
    update: c.yellow("replaces"),
    unchanged: c.dim("unchanged"),
    error: c.red("error"),
  };
  const label = (action: string) => labels[action] ?? safe(action);
  yield* Print.table(result.rows, [
    { header: "line", value: (r) => String(r.line), align: "right" },
    {
      header: "rate",
      value: (r) =>
        r.rate ? safe(`1 ${r.rate.fromCurrency} = ${r.rate.rate} ${r.rate.toCurrency}`) : "",
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
        `${label(r.action)}${r.previousRate ? c.dim(` (was ${safe(r.previousRate)})`) : ""}${
          r.error ? ` ${safe(r.error)}` : ""
        }`,
    },
  ]);
  yield* Print.line();
  yield* Print.line(
    `${result.counts.create} new, ${result.counts.update} replace a stored rate, ` +
      `${result.counts.unchanged} unchanged, ${result.counts.error} with errors`,
  );
});

/**
 * `infrawrench currency import <file.csv> [--skip-invalid] [-y]`: upload many
 * stated rates.
 *
 * Always previews first (a server-side dry run that classifies every row
 * against the stored table), then asks before writing; `-y` skips the question
 * and is the only way to apply from a non-interactive shell, so a script has
 * to say so. A file with invalid rows writes nothing unless `--skip-invalid`,
 * and exits 1.
 */
const importRates = Command.make(
  "import",
  {
    file: Argument.String("file.csv").pipe(
      Argument.withDescription("The rates to upload"),
      Argument.optional,
    ),
    skipInvalid: Flag.Boolean("skip-invalid").pipe(
      Flag.withDescription("Write the valid rows of a file that has invalid ones"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
    yes: Flag.Boolean("yes").pipe(
      Flag.withAlias("y"),
      Flag.withDescription("Apply after the preview without asking"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
  },
  Effect.fn("currency.import")(function* (input) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    yield* requireCloud;
    if (Option.isNone(input.file) || !input.file.value) {
      return yield* new CliUsageError({
        message: "Usage: infrawrench currency import <file.csv> [--skip-invalid] [-y]",
      });
    }
    const path = input.file.value;
    const csv = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (e) =>
        new CliFailure({
          message: `Couldn't read ${path}: ${e instanceof Error ? e.message : String(e)}`,
        }),
    });
    const org = yield* currentOrg;
    const importPath = "/currency/rates/import";
    const send = (body: { csv: string; dryRun?: boolean; skipInvalid?: boolean }) =>
      api.json(org.id, importPath, { method: "POST", body: JSON.stringify(body) });
    const asJson = (body: unknown) =>
      spreadBody({ org: org.id }, body, importPath).pipe(Effect.flatMap(Print.json));

    const previewBody = yield* send({ csv, dryRun: true });
    const preview = yield* decodeBody(ImportResult, importPath)(previewBody);
    const writable = preview.counts.create + preview.counts.update;
    const json = session.output === "json";
    if (!json) yield* printImportResult(preview);

    const blocked = preview.counts.error > 0 && !input.skipInvalid;
    if (writable === 0 || blocked) {
      if (json) yield* asJson(previewBody);
      else if (blocked) {
        yield* Print.line(
          c.yellow(
            "Nothing written: fix the rows above, or pass --skip-invalid to import the valid ones.",
          ),
        );
      } else {
        yield* Print.line(c.dim("Nothing to write: every rate in the file is already stored."));
      }
      if (blocked) return yield* new CliExit({ exitCode: 1 });
      return;
    }
    if (!input.yes) {
      if (!process.stdin.isTTY || json) {
        if (json) return yield* asJson(previewBody);
        return yield* Print.line(c.dim("Preview only. Re-run with -y to write these rates."));
      }
      const ok = yield* confirm(`Write ${writable} rate${writable === 1 ? "" : "s"}?`);
      if (!ok) return;
    }
    const resultBody = yield* send({ csv, skipInvalid: input.skipInvalid });
    if (json) return yield* asJson(resultBody);
    const result = yield* decodeBody(ImportResult, importPath)(resultBody);
    yield* Print.line(
      c.green(
        `Imported: ${result.counts.create} new, ${result.counts.update} replaced, ` +
          `${result.counts.unchanged} unchanged${result.counts.error ? `, ${result.counts.error} skipped` : ""}.`,
      ),
    );
  }),
).pipe(
  Command.withDescription("Upload many stated rates; previews every row and asks before writing"),
);

// Read-only on purpose apart from `import`: stating a single rate restates
// every converted total the org reports and rides `org:settings:write`.
export const currencyCommand = Command.make("currency", {}, overview).pipe(
  Command.withDescription(
    "Display currency, automatic-rate settings, ECB feed state and stated rates",
  ),
  Command.withSubcommands([rate, feed, importRates, template]),
);
