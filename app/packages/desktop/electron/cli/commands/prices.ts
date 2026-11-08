// `infrawrench prices search|compare`: the Price catalog from the terminal.
//
// `search` lists provider list prices filtered by provider, specs, GPU and
// price; `compare` finds the cheapest instance per provider meeting a vCPU /
// memory / GPU target (or a reference instance's specs). Both run through the
// same `/price-catalog/*` routes the app's Price catalog tab and the MCP tools
// use, so the numbers agree everywhere.
//
// Cloud-only: the catalog is assembled server-side, where providers whose
// price API needs credentials are fetched with one of the org's accounts.
//
// Filters are passed, as typed, through client-core's query normalizers (the
// same ones the server applies), loaded dynamically because this module graph
// is CommonJS and client-core is ESM; electron-vite bundles it.
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type {
  PriceCatalogCompareResponse,
  PriceCatalogSearchResponse,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure, CliUsageError } from "../effect/errors";
import * as Print from "../effect/print";
import { limit } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { knownOr, spreadBody, Unrecognized, wire } from "../effect/wire";
import { c, safe, type Column } from "../output";

type Core = typeof import("@infrawrench/client-core", { with: { "resolution-mode": "import" } });
const loadCore = Effect.promise((): Promise<Core> => import("@infrawrench/client-core"));

const USAGE = `Usage:
  infrawrench prices search [query] [--provider aws,gcp] [--area europe] [--region <id>]
                            [--min-vcpus 4] [--max-vcpus 8] [--min-memory 16] [--max-memory 64]
                            [--gpu required|none] [--gpu-model H100] [--gpus 1] [--max-price 200]
                            [--rate on-demand|spot|reserved|savings-plan] [--term 1yr|3yr]
                            [--sort price|vcpus|memory|gpus|name] [--desc] [--limit 25]
  infrawrench prices compare [--vcpus 4] [--memory 16] [--gpus 1] [--gpu-model L4]
                            [--provider <plugin> <sku>  compare against a product's specs]
                            [--area europe] [--rate on-demand]`;

const RateType = knownOr(["on-demand", "spot", "reserved", "savings-plan"]);
const Area = knownOr([
  "north-america",
  "europe",
  "asia-pacific",
  "south-america",
  "oceania",
  "middle-east",
  "africa",
]);

const Row = Schema.Struct({
  pluginName: Schema.String,
  name: Schema.String,
  specs: Schema.Struct({
    vcpus: Schema.optionalKey(Schema.Finite),
    memoryGb: Schema.optionalKey(Schema.Finite),
    gpuCount: Schema.optionalKey(Schema.Finite),
    gpuModel: Schema.optionalKey(Schema.String),
    storageGb: Schema.optionalKey(Schema.Finite),
  }),
  region: Schema.String,
  price: Schema.Struct({
    amount: Schema.Finite,
    currency: Schema.String,
    unit: knownOr(["hour", "month", "gb-month"]),
  }),
  monthlyAmount: Schema.NullOr(Schema.Finite),
});
type Row = typeof Row.Type;

const Search = wire<PriceCatalogSearchResponse>()(
  Schema.Struct({
    rows: Schema.Array(Row),
    total: Schema.Finite,
    area: Area,
    rateType: RateType,
    providers: Schema.Array(
      Schema.Struct({
        pluginName: Schema.String,
        // A state this build does not know falls through to the last note.
        state: Schema.String,
        truncated: Schema.Boolean,
        error: Schema.NullOr(Schema.String),
        permission: Schema.NullOr(Schema.String),
      }),
    ),
    currencies: Schema.Array(Schema.String),
    mixedCurrencies: Schema.Boolean,
  }),
);

const Compare = wire<PriceCatalogCompareResponse>()(
  Schema.Struct({
    target: Schema.Struct({
      vcpus: Schema.NullOr(Schema.Finite),
      memoryGb: Schema.NullOr(Schema.Finite),
      gpuCount: Schema.NullOr(Schema.Finite),
      gpuModel: Schema.NullOr(Schema.String),
    }),
    reference: Schema.NullOr(Schema.Struct({ name: Schema.String })),
    area: Area,
    rateType: RateType,
    providers: Schema.Array(
      Schema.Struct({
        pluginName: Schema.String,
        region: Schema.NullOr(Schema.String),
        state: Schema.String,
        best: Schema.NullOr(Row),
        alternatives: Schema.Array(Row),
      }),
    ),
    mixedCurrencies: Schema.Boolean,
  }),
);

const rateLabel = (core: Core, rate: typeof RateType.Type) =>
  rate instanceof Unrecognized ? safe(rate.raw) : core.PRICE_RATE_TYPE_LABELS[rate];
const areaLabel = (core: Core, area: typeof Area.Type) =>
  area instanceof Unrecognized ? safe(area.raw) : core.PRICE_CATALOG_AREA_LABELS[area];
const unitLabel = (core: Core, unit: Row["price"]["unit"]) =>
  unit instanceof Unrecognized ? `/${safe(unit.raw)}` : core.formatCatalogUnit(unit);

/** A filter flag, kept as typed: client-core's normalizers parse it as the route does. */
const raw = (name: string, metavar: string, description: string) =>
  Flag.String(name).pipe(
    Flag.withMetavar(metavar),
    Flag.withDescription(description),
    Flag.optional,
  );

const provider = raw(
  "provider",
  "plugin[,plugin]",
  "Only these providers (compare: with a sku, the reference product's provider)",
);
const area = raw("area", "area", "Region area: north-america, europe, asia-pacific, …");
const rate = raw("rate", "rate", "on-demand, spot, reserved or savings-plan");
const vcpus = raw("vcpus", "n", "vCPUs (search: at least; compare: the target)");
const memory = raw("memory", "GB", "Memory in GB (search: at least; compare: the target)");
const minVcpus = raw("min-vcpus", "n", "At least this many vCPUs");
const minMemory = raw("min-memory", "GB", "At least this much memory");
const gpus = raw("gpus", "n", "At least this many GPUs");
const gpuModel = raw("gpu-model", "model", "GPU model substring, e.g. H100 or L4");

const refuseLocal = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message: "`prices` is cloud-only: drop --local, or pass --org <id|name>.",
    });
  }
});

const providerNotes = Effect.fnUntraced(function* (providers: (typeof Search.Type)["providers"]) {
  for (const p of providers) {
    if (p.state === "ready" && !p.truncated && !p.error) continue;
    const why =
      p.state === "no-account"
        ? "not searched: its price API needs an account in this org"
        : p.state === "no-region"
          ? "no region in this area"
          : p.state === "loading"
            ? "still fetching, run again shortly"
            : p.state === "error"
              ? `prices could not be read: ${safe(p.error)}${p.permission ? ` (needs ${p.permission})` : ""}`
              : p.truncated
                ? "list incomplete (page limit reached)"
                : `showing the last good list: ${safe(p.error)}`;
    yield* Print.line(c.dim(`  ${p.pluginName}: ${why}`));
  }
});

const search = Command.make(
  "search",
  {
    query: Argument.String("query").pipe(
      Argument.withDescription("Free text over sku, name, series and GPU model"),
      Argument.variadic(),
    ),
    provider,
    region: raw("region", "id", "An exact provider region"),
    area,
    rate,
    term: raw("term", "term", "For reserved / savings-plan: 1yr or 3yr"),
    vcpus,
    memory,
    minVcpus,
    maxVcpus: raw("max-vcpus", "n", "At most this many vCPUs"),
    minMemory,
    maxMemory: raw("max-memory", "GB", "At most this much memory"),
    gpu: raw("gpu", "required|none", "Only GPU instances, or none"),
    gpus,
    gpuModel,
    maxPrice: raw("max-price", "amount", "At most this much per month"),
    sort: raw("sort", "price|vcpus|memory|gpus|name", "Sort order (default: price)"),
    desc: Flag.Boolean("desc").pipe(
      Flag.withDescription("Sort descending"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
    limit: limit.pipe(Flag.withDescription("Rows to list (default 25)")),
  },
  Effect.fn("prices.search")(function* (input) {
    yield* refuseLocal;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const core = yield* loadCore;
    const org = yield* currentOrg;
    const get = Option.getOrUndefined;
    const query = core.normalizePriceCatalogSearchQuery({
      q: input.query.join(" "),
      pluginIds: get(input.provider),
      region: get(input.region),
      area: get(input.area),
      rateType: get(input.rate),
      term: get(input.term),
      minVcpus: get(input.minVcpus) ?? get(input.vcpus),
      maxVcpus: get(input.maxVcpus),
      minMemoryGb: get(input.minMemory) ?? get(input.memory),
      maxMemoryGb: get(input.maxMemory),
      gpu: get(input.gpu),
      gpuModel: get(input.gpuModel),
      minGpus: get(input.gpus),
      maxMonthlyPrice: get(input.maxPrice),
      sort: get(input.sort),
      order: input.desc ? "desc" : undefined,
      limit: get(input.limit) ?? 25,
    });
    const path = `/price-catalog/search${core.priceCatalogQueryString(query)}`;
    const body = yield* api.json(org.id, path);
    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, path));
    }
    const res = yield* decodeBody(Search, path)(body);
    yield* Print.line(
      `${c.bold(org.displayName)} ${c.dim(
        `· ${res.rows.length} of ${res.total} instance types · ${rateLabel(core, res.rateType)} · ${areaLabel(core, res.area)}`,
      )}`,
    );
    yield* providerNotes(res.providers);
    yield* Print.line();
    const columns: Column<Row>[] = [
      { header: "provider", value: (r) => c.dim(r.pluginName) },
      { header: "instance", value: (r) => safe(r.name) },
      { header: "specs", value: (r) => core.formatCatalogSpecs(r.specs) },
      { header: "region", value: (r) => safe(r.region) },
      {
        header: "rate",
        value: (r) =>
          `${core.formatCatalogAmount(r.price.amount, r.price.currency)}${unitLabel(core, r.price.unit)}`,
        align: "right",
      },
      {
        header: "per month",
        value: (r) =>
          r.monthlyAmount === null
            ? c.dim("n/a")
            : core.formatCatalogMonthly(r.monthlyAmount, r.price.currency),
        align: "right",
      },
    ];
    yield* Print.table(res.rows, columns);
    if (res.mixedCurrencies) {
      yield* Print.line();
      yield* Print.line(
        c.yellow(
          `! Prices are in ${res.currencies.join(", ")} and sort by face value. Set a display currency and exchange rates in Settings to compare in one.`,
        ),
      );
    }
    yield* Print.line();
    yield* Print.line(
      c.dim("List prices from each provider's published source; discounts are not applied."),
    );
  }),
).pipe(Command.withDescription("Provider list prices, filtered by provider, specs, GPU and price"));

const compare = Command.make(
  "compare",
  {
    sku: Argument.String("sku").pipe(
      Argument.withDescription("With --provider: compare against this product's specs"),
      Argument.optional,
    ),
    provider,
    area,
    rate,
    vcpus,
    memory,
    minVcpus,
    minMemory,
    gpus,
    gpuModel,
  },
  Effect.fn("prices.compare")(function* (input) {
    yield* refuseLocal;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const core = yield* loadCore;
    const org = yield* currentOrg;
    const get = Option.getOrUndefined;
    const referencePluginId = get(input.provider);
    const referenceSku = get(input.sku);
    const reference = referencePluginId && referenceSku ? { referencePluginId, referenceSku } : {};
    const query = core.normalizePriceCatalogCompareQuery({
      ...reference,
      vcpus: get(input.vcpus) ?? get(input.minVcpus),
      memoryGb: get(input.memory) ?? get(input.minMemory),
      gpuCount: get(input.gpus),
      gpuModel: get(input.gpuModel),
      area: get(input.area),
      rateType: get(input.rate),
      pluginIds: "referencePluginId" in reference ? undefined : referencePluginId,
    });
    if (
      !query.reference &&
      query.vcpus === undefined &&
      query.memoryGb === undefined &&
      query.gpuCount === undefined &&
      !query.gpuModel
    ) {
      return yield* new CliUsageError({ message: USAGE });
    }
    const path = `/price-catalog/compare${core.priceCatalogQueryString(query)}`;
    const body = yield* api.json(org.id, path);
    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, path));
    }
    const res = yield* decodeBody(Compare, path)(body);
    const t = res.target;
    const target = [
      t.vcpus !== null ? `≥${t.vcpus} vCPU` : null,
      t.memoryGb !== null ? `≥${t.memoryGb} GB` : null,
      t.gpuCount !== null ? `≥${t.gpuCount} GPU` : null,
      t.gpuModel ? t.gpuModel : null,
    ]
      .filter(Boolean)
      .join(" · ");
    yield* Print.line(
      `${c.bold(res.reference ? `Equivalents of ${res.reference.name}` : "Cheapest match")} ${c.dim(
        `· ${target} · ${rateLabel(core, res.rateType)} · ${areaLabel(core, res.area)}`,
      )}`,
    );
    yield* Print.line();
    yield* Print.table(res.providers, [
      { header: "provider", value: (p) => p.pluginName },
      { header: "region", value: (p) => c.dim(safe(p.region ?? "")) },
      {
        header: "instance",
        value: (p) =>
          p.best
            ? safe(p.best.name)
            : c.dim(
                p.state === "ready"
                  ? "nothing meets every spec"
                  : p.state === "no-account"
                    ? "needs an account"
                    : safe(p.state),
              ),
      },
      { header: "specs", value: (p) => (p.best ? core.formatCatalogSpecs(p.best.specs) : "") },
      {
        header: "per month",
        value: (p) =>
          p.best?.monthlyAmount != null
            ? core.formatCatalogMonthly(p.best.monthlyAmount, p.best.price.currency)
            : "",
        align: "right",
      },
      {
        header: "runners-up",
        value: (p) =>
          c.dim(
            p.alternatives
              .map((a) =>
                a.monthlyAmount !== null
                  ? `${a.name} ${core.formatCatalogMonthly(a.monthlyAmount, a.price.currency)}`
                  : a.name,
              )
              .join(", "),
          ),
      },
    ]);
    if (res.mixedCurrencies) {
      yield* Print.line();
      yield* Print.line(
        c.yellow("! Providers quote in different currencies and are ordered by face value."),
      );
    }
  }),
).pipe(
  Command.withDescription(
    "The cheapest instance per provider meeting a vCPU / memory / GPU target, or a product's specs",
  ),
);

export const prices = Command.make(
  "prices",
  {},
  Effect.fn("prices")(function* () {
    yield* refuseLocal;
    return yield* new CliUsageError({ message: USAGE });
  }),
).pipe(
  Command.withDescription("The price catalog: search list prices, or compare providers"),
  Command.withSubcommands([search, compare]),
);
