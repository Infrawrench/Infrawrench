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
// Filters are passed through client-core's query normalizers (the same ones
// the server applies), loaded dynamically because this module graph is
// CommonJS and client-core is ESM; electron-vite bundles it.
import type {
  PriceCatalogCompareResponse,
  PriceCatalogProviderStatus,
  PriceCatalogRow,
  PriceCatalogSearchResponse,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import type { PriceFlags, RangeFlags } from "../args";
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import { c, printJson, println, printTable, safe, type Column } from "../output";

const USAGE = `Usage:
  infrawrench prices search [query] [--provider aws,gcp] [--area europe] [--region <id>]
                            [--min-vcpus 4] [--max-vcpus 8] [--min-memory 16] [--max-memory 64]
                            [--gpu required|none] [--gpu-model H100] [--gpus 1] [--max-price 200]
                            [--rate on-demand|spot|reserved|savings-plan] [--term 1yr|3yr]
                            [--sort price|vcpus|memory|gpus|name] [--desc] [--limit 25]
  infrawrench prices compare [--vcpus 4] [--memory 16] [--gpus 1] [--gpu-model L4]
                            [--provider <plugin> <sku>  compare against a product's specs]
                            [--area europe] [--rate on-demand]`;

function providerNotes(providers: PriceCatalogProviderStatus[]): void {
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
    println(c.dim(`  ${p.pluginName}: ${why}`));
  }
}

export async function cmdPrices(
  ctx: CliContext,
  sub: string,
  args: string[],
  prices: PriceFlags,
  range: RangeFlags,
): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError("`prices` is cloud-only: drop --local, or pass --org <id|name>.");
  }
  if (sub !== "search" && sub !== "compare") throw new CliError(USAGE, 2);
  const core = await import("@infrawrench/client-core");
  const org = await resolveOrg(ctx);

  if (sub === "search") {
    const query = core.normalizePriceCatalogSearchQuery({
      q: args.join(" "),
      pluginIds: prices.provider,
      region: prices.region,
      area: prices.area,
      rateType: prices.rate,
      term: prices.term,
      minVcpus: prices.minVcpus ?? prices.vcpus,
      maxVcpus: prices.maxVcpus,
      minMemoryGb: prices.minMemory ?? prices.memory,
      maxMemoryGb: prices.maxMemory,
      gpu: prices.gpu,
      gpuModel: prices.gpuModel,
      minGpus: prices.gpus,
      maxMonthlyPrice: prices.maxPrice,
      sort: prices.sort,
      order: prices.desc ? "desc" : undefined,
      limit: range.limit ?? 25,
    });
    const res = await orgFetch<PriceCatalogSearchResponse>(
      org.id,
      `/price-catalog/search${core.priceCatalogQueryString(query)}`,
    );
    if (ctx.flags.output === "json") {
      printJson({ org: org.id, ...res });
      return;
    }
    println(
      `${c.bold(org.displayName)} ${c.dim(
        `· ${res.rows.length} of ${res.total} instance types · ${core.PRICE_RATE_TYPE_LABELS[res.rateType]} · ${core.PRICE_CATALOG_AREA_LABELS[res.area]}`,
      )}`,
    );
    providerNotes(res.providers);
    println();
    const columns: Column<PriceCatalogRow>[] = [
      { header: "provider", value: (r) => c.dim(r.pluginName) },
      { header: "instance", value: (r) => safe(r.name) },
      { header: "specs", value: (r) => core.formatCatalogSpecs(r.specs) },
      { header: "region", value: (r) => safe(r.region) },
      {
        header: "rate",
        value: (r) =>
          `${core.formatCatalogAmount(r.price.amount, r.price.currency)}${core.formatCatalogUnit(r.price.unit)}`,
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
    printTable(res.rows, columns);
    if (res.mixedCurrencies) {
      println();
      println(
        c.yellow(
          `! Prices are in ${res.currencies.join(", ")} and sort by face value. Set a display currency and exchange rates in Settings to compare in one.`,
        ),
      );
    }
    println();
    println(c.dim("List prices from each provider's published source; discounts are not applied."));
    return;
  }

  const reference =
    prices.provider && args[0] ? { referencePluginId: prices.provider, referenceSku: args[0] } : {};
  const query = core.normalizePriceCatalogCompareQuery({
    ...reference,
    vcpus: prices.vcpus ?? prices.minVcpus,
    memoryGb: prices.memory ?? prices.minMemory,
    gpuCount: prices.gpus,
    gpuModel: prices.gpuModel,
    area: prices.area,
    rateType: prices.rate,
    pluginIds: reference.referencePluginId ? undefined : prices.provider,
  });
  if (
    !query.reference &&
    query.vcpus === undefined &&
    query.memoryGb === undefined &&
    query.gpuCount === undefined &&
    !query.gpuModel
  ) {
    throw new CliError(USAGE, 2);
  }
  const res = await orgFetch<PriceCatalogCompareResponse>(
    org.id,
    `/price-catalog/compare${core.priceCatalogQueryString(query)}`,
  );
  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...res });
    return;
  }
  const t = res.target;
  const target = [
    t.vcpus !== null ? `≥${t.vcpus} vCPU` : null,
    t.memoryGb !== null ? `≥${t.memoryGb} GB` : null,
    t.gpuCount !== null ? `≥${t.gpuCount} GPU` : null,
    t.gpuModel ? t.gpuModel : null,
  ]
    .filter(Boolean)
    .join(" · ");
  println(
    `${c.bold(res.reference ? `Equivalents of ${res.reference.name}` : "Cheapest match")} ${c.dim(
      `· ${target} · ${core.PRICE_RATE_TYPE_LABELS[res.rateType]} · ${core.PRICE_CATALOG_AREA_LABELS[res.area]}`,
    )}`,
  );
  println();
  const rows = res.providers;
  printTable(rows, [
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
                  : p.state,
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
    println();
    println(c.yellow("! Providers quote in different currencies and are ordered by face value."));
  }
}
