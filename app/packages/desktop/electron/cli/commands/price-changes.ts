// `infrawrench price-changes`; list-price changes on instance types the org
// runs, one row per change with what it does to the month, and
// `price-changes catalog`, every change on one warehouse platform.
//
// Cloud only: the changes are found by the server's daily scan of the pricing
// warehouse's price history, which a local workspace has no access to.
// client-core is loaded on demand (the `prices` command's pattern), so the CLI
// takes no new runtime dependency.
import { Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import type {
  CatalogPriceChangeResponse,
  PriceChangeListResponse,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { days, lastDays, resolveDayWindow } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { wire } from "../effect/wire";
import { c, safe, type Column } from "../output";

type Core = typeof import("@infrawrench/client-core", { with: { "resolution-mode": "import" } });
const loadCore = Effect.promise((): Promise<Core> => import("@infrawrench/client-core"));

const Resource = Schema.Struct({ displayName: Schema.String });

const Change = Schema.Struct({
  platform: Schema.String,
  instanceType: Schema.String,
  region: Schema.String,
  selection: Schema.Record(Schema.String, Schema.String),
  oldHourlyUsd: Schema.Finite,
  newHourlyUsd: Schema.Finite,
  percent: Schema.Finite,
  effectiveAt: Schema.String,
  upcoming: Schema.Boolean,
  units: Schema.Finite,
  approximate: Schema.Boolean,
  monthlyImpactUsd: Schema.Finite,
  resources: Schema.Array(Resource),
  belowThreshold: Schema.Boolean,
  alertedAt: Schema.NullOr(Schema.String),
  scenarioModelId: Schema.NullOr(Schema.String),
});
type Change = typeof Change.Type;

const Listing = wire<PriceChangeListResponse>()(
  Schema.Struct({
    changes: Schema.Array(Change),
    available: Schema.Boolean,
    lastScannedAt: Schema.NullOr(Schema.String),
    minMonthlyImpactCents: Schema.Finite,
    minPercent: Schema.Finite,
  }),
);

const CatalogChange = Schema.Struct({
  instanceType: Schema.String,
  region: Schema.String,
  variant: Schema.String,
  oldHourlyUsd: Schema.Finite,
  newHourlyUsd: Schema.Finite,
  percent: Schema.Finite,
  effectiveAt: Schema.String,
});
type CatalogChange = typeof CatalogChange.Type;

const Catalog = wire<CatalogPriceChangeResponse>()(
  Schema.Struct({
    available: Schema.Boolean,
    platforms: Schema.Array(Schema.String),
    platform: Schema.String,
    days: Schema.Finite,
    changes: Schema.Array(CatalogChange),
    truncated: Schema.Boolean,
  }),
);

const tone = (amount: number) => (amount > 0 ? c.red : amount < 0 ? c.green : c.dim);

const cloudOnly = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message: "Price changes are found by the cloud's daily scan; drop --local.",
    });
  }
});

const all = Flag.Boolean("all").pipe(
  Flag.withDescription("Include changes under the organization's alert thresholds"),
);

const catalog = Command.make(
  "catalog",
  {
    platform: Flag.String("provider").pipe(
      Flag.withMetavar("platform"),
      Flag.withDescription("Pricing platform: ec2, rds, azure, gcp, alibaba, runpod… (default ec2)"),
      Flag.optional,
    ),
    days: days.pipe(Flag.withDescription("How far back (default 90, max 365)")),
    last: lastDays,
  },
  Effect.fn("price-changes.catalog")(function* (input) {
    yield* cloudOnly;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const core = yield* loadCore;
    const window = yield* resolveDayWindow(input, 90, 365);
    const params = new URLSearchParams({ days: String(window) });
    const platform = Option.getOrUndefined(input.platform);
    if (platform) params.set("platform", platform);
    const path = `/price-changes/catalog?${params.toString()}`;
    const body = yield* api.json(org.id, path);
    if (session.output === "json") return yield* Print.json(body);
    const response = yield* decodeBody(Catalog, path)(body);
    if (!response.available) {
      return yield* Print.line(c.dim("Price history is not available on this server."));
    }
    yield* Print.line(
      `${c.bold(safe(core.priceChangePlatformLabel(response.platform)))} ${c.dim(
        `· ${response.changes.length} change${response.changes.length === 1 ? "" : "s"} · last ${response.days}d`,
      )}`,
    );
    yield* Print.line();
    if (response.changes.length === 0) {
      return yield* Print.line(c.dim("No list-price changes in this period."));
    }
    const columns: Column<CatalogChange>[] = [
      { header: "instance", value: (r) => safe(r.instanceType) },
      { header: "region", value: (r) => c.dim(safe(r.region)) },
      { header: "variant", value: (r) => c.dim(safe(r.variant)) },
      {
        header: "hourly",
        value: (r) =>
          `${core.formatPriceChangeHourly(r.oldHourlyUsd)} → ${core.formatPriceChangeHourly(r.newHourlyUsd)}`,
        align: "right",
      },
      {
        header: "change",
        value: (r) => tone(r.percent)(core.formatPriceChangePercent(r.percent)),
        align: "right",
      },
      { header: "effective", value: (r) => core.priceChangeDay(r.effectiveAt) },
    ];
    yield* Print.table(response.changes, columns);
    if (response.truncated) {
      yield* Print.line();
      yield* Print.line(c.dim("The most recent changes only; narrow --days to see older ones."));
    }
  }),
).pipe(Command.withDescription("Every list-price change on one pricing platform"));

export const priceChanges = Command.make(
  "price-changes",
  {
    days: days.pipe(Flag.withDescription("How far back (default 180, max 730)")),
    last: lastDays,
    all,
  },
  Effect.fn("price-changes")(function* (input) {
    yield* cloudOnly;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const core = yield* loadCore;
    const window = yield* resolveDayWindow(input, 180, 730);
    const path = `/price-changes?days=${window}`;
    const body = yield* api.json(org.id, path);
    if (session.output === "json") return yield* Print.json(body);
    const response = yield* decodeBody(Listing, path)(body);

    if (!response.available) {
      yield* Print.line(c.dim("Price history is not available on this server."));
    }
    const shown = response.changes.filter((ch) => input.all || !ch.belowThreshold);
    const hidden = response.changes.length - shown.length;
    const net = shown.reduce((sum, ch) => sum + ch.monthlyImpactUsd, 0);
    yield* Print.line(
      `${c.bold(safe(org.displayName))} ${c.dim(
        `· ${shown.length} change${shown.length === 1 ? "" : "s"} · last ${window}d`,
      )}${shown.length > 0 ? `  ${tone(net)(`${core.formatPriceChangeUsd(net, { signed: true })}/mo net`)}` : ""}`,
    );
    yield* Print.line();
    if (shown.length === 0) {
      yield* Print.line(c.dim("No list-price changes on what you run in this period."));
    } else {
      const columns: Column<Change>[] = [
        {
          header: "instance",
          value: (ch) =>
            `${safe(ch.instanceType)} ${c.dim(
              safe(
                [
                  core.priceChangePlatformLabel(ch.platform),
                  ch.region !== "global" ? ch.region : "",
                  core.priceChangeVariantLabel(ch.selection),
                ]
                  .filter(Boolean)
                  .join(" · "),
              ),
            )}`,
        },
        {
          header: "hourly",
          value: (ch) =>
            `${core.formatPriceChangeHourly(ch.oldHourlyUsd)} → ${core.formatPriceChangeHourly(ch.newHourlyUsd)} ${tone(
              ch.percent,
            )(core.formatPriceChangePercent(ch.percent))}`,
          align: "right",
        },
        {
          header: "effective",
          value: (ch) =>
            `${core.priceChangeDay(ch.effectiveAt)}${ch.upcoming ? c.yellow(" upcoming") : ""}`,
        },
        {
          header: "running",
          value: (ch) => `${ch.approximate ? "≥" : ""}${ch.units}`,
          align: "right",
        },
        {
          header: "per month",
          value: (ch) =>
            tone(ch.monthlyImpactUsd)(
              core.formatPriceChangeUsd(ch.monthlyImpactUsd, { signed: true }),
            ),
          align: "right",
        },
        {
          header: "status",
          value: (ch) =>
            c.dim(
              [
                ch.alertedAt ? "alerted" : ch.belowThreshold ? "under threshold" : "",
                ch.scenarioModelId ? "scenario" : "",
              ]
                .filter(Boolean)
                .join(", "),
            ),
        },
      ];
      yield* Print.table(shown, columns);
    }
    yield* Print.line();
    if (hidden > 0) {
      yield* Print.line(
        c.dim(
          `${hidden} smaller change${hidden === 1 ? " is" : "s are"} under your thresholds (--all to list).`,
        ),
      );
    }
    yield* Print.line(
      c.dim(
        response.lastScannedAt
          ? `Published on-demand list prices in USD. Last checked ${response.lastScannedAt}.`
          : "Published on-demand list prices in USD. Not checked yet.",
      ),
    );
  }),
).pipe(
  Command.withDescription("List-price changes on instance types the organization runs"),
  Command.withSubcommands([catalog]),
);
