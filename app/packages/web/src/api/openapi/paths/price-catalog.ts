import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

export function registerPriceCatalogPaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  const Area = z
    .enum([
      "north-america",
      "south-america",
      "europe",
      "asia-pacific",
      "middle-east",
      "africa",
      "oceania",
    ])
    .openapi("PriceCatalogArea", {
      description:
        "Coarse geography. A provider without the requested region is priced in its first " +
        "declared region in this area.",
    });
  const RateType = z
    .enum(["on-demand", "spot", "reserved", "savings-plan"])
    .openapi("PriceRateType");
  const Family = z
    .enum(["compute", "gpu", "database", "kubernetes-node", "storage"])
    .openapi("PriceCatalogProductFamily");
  const ProviderState = z
    .enum(["ready", "no-account", "no-region", "loading", "error"])
    .openapi("PriceCatalogProviderState", {
      description:
        "`no-account`: the provider's price API needs credentials and the org has no account " +
        "on it. `loading`: the first fetch is still running, ask again shortly.",
    });

  const Specs = strict({
    vcpus: z.number().optional(),
    memoryGb: z.number().optional(),
    gpuCount: z.number().optional(),
    gpuModel: z.string().optional(),
    gpuMemoryGb: z.number().optional(),
    storageGb: z.number().optional(),
    storageType: z.string().optional(),
    architecture: z.string().optional(),
    network: z.string().optional(),
  }).openapi("PriceCatalogSpecs");

  const Price = strict({
    region: z.string(),
    rateType: RateType,
    unit: z.enum(["hour", "month", "gb-month"]),
    amount: z.number().describe("Price per `unit` in `currency`, the provider's list price."),
    currency: z.string().openapi({ example: "USD" }),
    term: z
      .string()
      .optional()
      .describe("Commitment term for reserved / savings plan: `1yr`, `3yr`."),
    paymentOption: z.string().optional(),
    effectiveDate: z
      .string()
      .optional()
      .describe(
        "When the provider says the rate took effect. Absent when the source does not say.",
      ),
  }).openapi("PriceCatalogPrice");

  const Comparable = strict({ amount: z.number(), currency: z.string() }).openapi(
    "PriceCatalogComparable",
  );

  const Row = strict({
    pluginId: enums.PluginId,
    pluginName: z.string(),
    serviceId: z.string(),
    serviceLabel: z.string(),
    sku: z.string().openapi({ example: "m7i.large" }),
    name: z.string(),
    family: Family,
    series: z.string().nullable(),
    specs: Specs,
    region: z.string(),
    regionLabel: z.string(),
    price: Price,
    monthlyAmount: z.number().nullable().describe("`price` as a 730-hour month."),
    comparable: Comparable.nullable().describe(
      "Monthly amount in the org's display currency (converted at the org's stated rate), " +
        "or in the native currency when no display currency is configured; null when there " +
        "is no rate. Sorting and `maxMonthlyPrice` use it.",
    ),
    otherPrices: z.array(Price).describe("The product's other rates in the same region."),
    estimate: strict({
      resourceTypeId: z.string(),
      fields: z.record(z.string(), z.string()),
    })
      .nullable()
      .describe("Create-form prefill for the plugin's estimate, with the region filled in."),
  }).openapi("PriceCatalogRow");

  const ProviderStatus = strict({
    pluginId: enums.PluginId,
    pluginName: z.string(),
    requiresCredentials: z.boolean(),
    permission: z.string().nullable(),
    source: strict({ name: z.string(), url: z.string() }),
    refreshHours: z.number(),
    services: z.array(strict({ id: z.string(), label: z.string(), family: Family })),
    regions: z.array(strict({ id: z.string(), label: z.string(), area: Area })),
    state: ProviderState,
    region: z.string().nullable(),
    error: z.string().nullable(),
    fetchedAt: IsoDateTime.nullable(),
    truncated: z.boolean(),
  }).openapi("PriceCatalogProviderStatus");

  const SearchResponse = strict({
    rows: z.array(Row),
    total: z.number().int(),
    offset: z.number().int(),
    limit: z.number().int(),
    area: Area,
    rateType: RateType,
    providers: z.array(ProviderStatus),
    displayCurrency: z.string().nullable(),
    currencies: z.array(z.string()),
    mixedCurrencies: z
      .boolean()
      .describe("True when rows were sorted across currencies with no common comparable figure."),
    gpuModels: z.array(z.string()),
    generatedAt: IsoDateTime,
  }).openapi("PriceCatalogSearchResponse");

  const CompareTarget = strict({
    vcpus: z.number().nullable(),
    memoryGb: z.number().nullable(),
    gpuCount: z.number().nullable(),
    gpuModel: z.string().nullable(),
  }).openapi("PriceCatalogCompareTarget");

  const CompareProvider = strict({
    pluginId: enums.PluginId,
    pluginName: z.string(),
    region: z.string().nullable(),
    regionLabel: z.string().nullable(),
    state: ProviderState,
    error: z.string().nullable(),
    best: Row.nullable().describe("Cheapest product meeting every stated spec."),
    alternatives: z.array(Row),
  }).openapi("PriceCatalogCompareProvider");

  const CompareResponse = strict({
    target: CompareTarget,
    reference: Row.nullable(),
    area: Area,
    rateType: RateType,
    providers: z.array(CompareProvider),
    displayCurrency: z.string().nullable(),
    mixedCurrencies: z.boolean(),
    generatedAt: IsoDateTime,
  }).openapi("PriceCatalogCompareResponse");

  const csv = (description: string) => z.string().optional().describe(description);
  const numeric = (description: string) =>
    z
      .string()
      .regex(/^\d+(\.\d+)?$/)
      .optional()
      .describe(description);

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/price-catalog/providers",
    tags: ["Price catalog"],
    summary: "List the providers that publish a price catalog",
    description:
      "Every plugin that declares a price catalog, with its source, refresh cadence, services, " +
      "regions and whether its price API needs credentials. A credentialed provider the org " +
      "has no account on reports `no-account`.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Catalog providers",
        content: {
          "application/json": { schema: strict({ providers: z.array(ProviderStatus) }) },
        },
      },
      ...ErrorResponses,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/price-catalog/search",
    tags: ["Price catalog"],
    summary: "Search provider list prices",
    description:
      "Search instance types across every catalog provider: one row per product priced at the " +
      "requested rate type in the region chosen for each provider. Filters narrow by provider, " +
      "service, specs, GPU and price; rows sort by monthly price by default.",
    request: {
      params: OrgIdParam,
      query: strict({
        q: z.string().optional().describe("Free text over SKU, name, series and GPU model."),
        pluginIds: csv("Comma-separated plugin ids."),
        serviceIds: csv("Comma-separated service ids (from the providers list)."),
        families: csv("Comma-separated product families."),
        region: z
          .string()
          .optional()
          .describe("Exact provider region, for providers that declare it."),
        area: Area.optional(),
        minVcpus: numeric("Minimum vCPUs."),
        maxVcpus: numeric("Maximum vCPUs."),
        minMemoryGb: numeric("Minimum memory, GB."),
        maxMemoryGb: numeric("Maximum memory, GB."),
        gpu: z.enum(["any", "required", "none"]).optional(),
        gpuModel: z.string().optional().describe("Case-insensitive substring, e.g. `H100`."),
        minGpus: numeric("Minimum GPU count."),
        maxMonthlyPrice: numeric("Upper bound on the comparable monthly price."),
        rateType: RateType.optional(),
        term: z.string().optional().describe("`1yr` or `3yr` for commitments."),
        sort: z.enum(["price", "vcpus", "memory", "gpus", "name"]).optional(),
        order: z.enum(["asc", "desc"]).optional(),
        limit: numeric("Rows per page, 1 to 500. Default 100."),
        offset: numeric("Rows to skip."),
      }),
    },
    responses: {
      200: {
        description: "Matching catalog rows",
        content: { "application/json": { schema: SearchResponse } },
      },
      ...ErrorResponses,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/price-catalog/compare",
    tags: ["Price catalog"],
    summary: "Compare equivalent instances across providers",
    description:
      "The cheapest product per provider that meets every stated spec (at least the vCPUs, " +
      "memory and GPUs asked for), in each provider's region for the area. Give the target as " +
      "specs, or name a reference product and its specs are used.",
    request: {
      params: OrgIdParam,
      query: strict({
        vcpus: numeric("Minimum vCPUs."),
        memoryGb: numeric("Minimum memory, GB."),
        gpuCount: numeric("Minimum GPUs."),
        gpuModel: z.string().optional(),
        referencePluginId: z.string().optional(),
        referenceSku: z.string().optional(),
        area: Area.optional(),
        rateType: RateType.optional(),
        pluginIds: csv("Comma-separated plugin ids."),
        alternatives: numeric("Runners-up per provider, 0 to 10. Default 2."),
      }),
    },
    responses: {
      200: {
        description: "Best match per provider",
        content: { "application/json": { schema: CompareResponse } },
      },
      ...ErrorResponses,
    },
  });
}
