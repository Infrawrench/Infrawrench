/**
 * The org-level price catalog: `/api/org/:orgId/price-catalog`, the endpoint
 * definitions. Every catalog provider's published list prices, searchable and
 * comparable across providers.
 *
 * `resources:read`, like right-sizing: nothing here is the org's billing
 * data, but a credentialed provider's catalog is fetched with one of the
 * org's accounts, so the routes stay authenticated and org-scoped.
 *
 * The query parameters are documented here; the handlers pass the raw query
 * to client-core's normalizers, which also read a few undocumented aliases
 * (`provider`, `family`, `maxPrice`) and drop anything they do not recognise.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { pattern } from "../schemas";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import {
  BadRequest,
  Conflict,
  Forbidden,
  InternalServerError,
  NotFound,
  PaymentRequired,
  ServiceUnavailable,
  Unauthorized,
} from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, OrgParams } from "../http/schemas/common";
import { documentedAs } from "../http/schemas/documented";
import { PluginId } from "../http/schemas/plugin-registry";

/** The error slots the hand-written spec spread onto every operation here. */
const CatalogErrors = [
  BadRequest,
  Unauthorized,
  PaymentRequired,
  Forbidden,
  NotFound,
  Conflict,
  InternalServerError,
  ServiceUnavailable,
] as const;

const Area = Schema.Literals([
  "north-america",
  "south-america",
  "europe",
  "asia-pacific",
  "middle-east",
  "africa",
  "oceania",
]).annotate({
  identifier: "PriceCatalogArea",
  description:
    "Coarse geography. A provider without the requested region is priced in its first " +
    "declared region in this area.",
});

const RateType = Schema.Literals(["on-demand", "spot", "reserved", "savings-plan"]).annotate({
  identifier: "PriceRateType",
});

const Family = Schema.Literals([
  "compute",
  "gpu",
  "database",
  "kubernetes-node",
  "storage",
]).annotate({ identifier: "PriceCatalogProductFamily" });

const ProviderState = Schema.Literals([
  "ready",
  "no-account",
  "no-region",
  "loading",
  "error",
]).annotate({
  identifier: "PriceCatalogProviderState",
  description:
    "`no-account`: the provider's price API needs credentials and the org has no account " +
    "on it. `loading`: the first fetch is still running, ask again shortly.",
});

const Specs = Schema.Struct({
  vcpus: Schema.optionalKey(Schema.Finite),
  memoryGb: Schema.optionalKey(Schema.Finite),
  gpuCount: Schema.optionalKey(Schema.Finite),
  gpuModel: Schema.optionalKey(Schema.String),
  gpuMemoryGb: Schema.optionalKey(Schema.Finite),
  storageGb: Schema.optionalKey(Schema.Finite),
  storageType: Schema.optionalKey(Schema.String),
  architecture: Schema.optionalKey(Schema.String),
  network: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "PriceCatalogSpecs" });

const Price = Schema.Struct({
  region: Schema.String,
  rateType: RateType,
  unit: Schema.Literals(["hour", "month", "gb-month"]),
  amount: Schema.Finite.annotate({
    description: "Price per `unit` in `currency`, the provider's list price.",
  }),
  currency: Schema.String.annotate({ examples: ["USD"] }),
  term: Schema.optionalKey(
    Schema.String.annotate({
      description: "Commitment term for reserved / savings plan: `1yr`, `3yr`.",
    }),
  ),
  paymentOption: Schema.optionalKey(Schema.String),
  effectiveDate: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "When the provider says the rate took effect. Absent when the source does not say.",
    }),
  ),
}).annotate({ identifier: "PriceCatalogPrice" });

const Comparable = Schema.Struct({ amount: Schema.Finite, currency: Schema.String }).annotate({
  identifier: "PriceCatalogComparable",
});

const Row = Schema.Struct({
  pluginId: PluginId,
  pluginName: Schema.String,
  serviceId: Schema.String,
  serviceLabel: Schema.String,
  sku: Schema.String.annotate({ examples: ["m7i.large"] }),
  name: Schema.String,
  family: Family,
  series: Schema.NullOr(Schema.String),
  specs: Specs,
  region: Schema.String,
  regionLabel: Schema.String,
  price: Price,
  monthlyAmount: Schema.NullOr(Schema.Finite).annotate({
    description: "`price` as a 730-hour month.",
  }),
  comparable: Schema.NullOr(Comparable).annotate({
    description:
      "Monthly amount in the org's display currency (converted at the org's stated rate), " +
      "or in the native currency when no display currency is configured; null when there " +
      "is no rate. Sorting and `maxMonthlyPrice` use it.",
  }),
  otherPrices: Schema.Array(Price).annotate({
    description: "The product's other rates in the same region.",
  }),
  estimate: Schema.NullOr(
    Schema.Struct({
      resourceTypeId: Schema.String,
      fields: Schema.Record(Schema.String, Schema.String),
    }),
  ).annotate({
    description: "Create-form prefill for the plugin's estimate, with the region filled in.",
  }),
}).annotate({ identifier: "PriceCatalogRow" });

const ProviderStatus = Schema.Struct({
  pluginId: PluginId,
  pluginName: Schema.String,
  requiresCredentials: Schema.Boolean,
  permission: Schema.NullOr(Schema.String),
  source: Schema.Struct({ name: Schema.String, url: Schema.String }),
  refreshHours: Schema.Finite,
  services: Schema.Array(
    Schema.Struct({ id: Schema.String, label: Schema.String, family: Family }),
  ),
  regions: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String, area: Area })),
  state: ProviderState,
  region: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  fetchedAt: Schema.NullOr(IsoDateTime),
  truncated: Schema.Boolean,
}).annotate({ identifier: "PriceCatalogProviderStatus" });

export const PriceCatalogProviders = Schema.Struct({ providers: Schema.Array(ProviderStatus) });

export const PriceCatalogSearchResponse = Schema.Struct({
  rows: Schema.Array(Row),
  total: Schema.Int,
  offset: Schema.Int,
  limit: Schema.Int,
  area: Area,
  rateType: RateType,
  providers: Schema.Array(ProviderStatus),
  displayCurrency: Schema.NullOr(Schema.String),
  currencies: Schema.Array(Schema.String),
  mixedCurrencies: Schema.Boolean.annotate({
    description: "True when rows were sorted across currencies with no common comparable figure.",
  }),
  gpuModels: Schema.Array(Schema.String),
  generatedAt: IsoDateTime,
}).annotate({ identifier: "PriceCatalogSearchResponse" });

const CompareTarget = Schema.Struct({
  vcpus: Schema.NullOr(Schema.Finite),
  memoryGb: Schema.NullOr(Schema.Finite),
  gpuCount: Schema.NullOr(Schema.Finite),
  gpuModel: Schema.NullOr(Schema.String),
}).annotate({ identifier: "PriceCatalogCompareTarget" });

const CompareProvider = Schema.Struct({
  pluginId: PluginId,
  pluginName: Schema.String,
  region: Schema.NullOr(Schema.String),
  regionLabel: Schema.NullOr(Schema.String),
  state: ProviderState,
  error: Schema.NullOr(Schema.String),
  best: Schema.NullOr(Row).annotate({
    description: "Cheapest product meeting every stated spec.",
  }),
  alternatives: Schema.Array(Row),
}).annotate({ identifier: "PriceCatalogCompareProvider" });

export const PriceCatalogCompareResponse = Schema.Struct({
  target: CompareTarget,
  reference: Schema.NullOr(Row),
  area: Area,
  rateType: RateType,
  providers: Schema.Array(CompareProvider),
  displayCurrency: Schema.NullOr(Schema.String),
  mixedCurrencies: Schema.Boolean,
  generatedAt: IsoDateTime,
}).annotate({ identifier: "PriceCatalogCompareResponse" });

/** A query parameter read as sent and documented as `doc`. */
const param = <S extends Schema.Top>(doc: S) => Schema.optionalKey(documentedAs(doc));
const text = (description?: string) =>
  param(description === undefined ? Schema.String : Schema.String.annotate({ description }));
const numeric = (description: string) =>
  param(Schema.String.annotate({ description }).check(pattern(/^\d+(\.\d+)?$/)));
const csv = (description: string) => text(description);

export class PriceCatalogGroup extends HttpApiGroup.make("priceCatalog")
  .add(
    HttpApiEndpoint.get("providers", "/providers", {
      params: OrgParams,
      success: PriceCatalogProviders,
      error: CatalogErrors,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List the providers that publish a price catalog")
      .annotate(
        OpenApi.Description,
        "Every plugin that declares a price catalog, with its source, refresh cadence, services, " +
          "regions and whether its price API needs credentials. A credentialed provider the org " +
          "has no account on reports `no-account`.",
      )
      .annotate(SuccessDescription, "Catalog providers"),
    HttpApiEndpoint.get("search", "/search", {
      params: OrgParams,
      query: {
        q: text("Free text over SKU, name, series and GPU model."),
        pluginIds: csv("Comma-separated plugin ids."),
        serviceIds: csv("Comma-separated service ids (from the providers list)."),
        families: csv("Comma-separated product families."),
        region: text("Exact provider region, for providers that declare it."),
        area: param(Area),
        minVcpus: numeric("Minimum vCPUs."),
        maxVcpus: numeric("Maximum vCPUs."),
        minMemoryGb: numeric("Minimum memory, GB."),
        maxMemoryGb: numeric("Maximum memory, GB."),
        gpu: param(Schema.Literals(["any", "required", "none"])),
        gpuModel: text("Case-insensitive substring, e.g. `H100`."),
        minGpus: numeric("Minimum GPU count."),
        maxMonthlyPrice: numeric("Upper bound on the comparable monthly price."),
        rateType: param(RateType),
        term: text("`1yr` or `3yr` for commitments."),
        sort: param(Schema.Literals(["price", "vcpus", "memory", "gpus", "name"])),
        order: param(Schema.Literals(["asc", "desc"])),
        limit: numeric("Rows per page, 1 to 500. Default 100."),
        offset: numeric("Rows to skip."),
      },
      success: PriceCatalogSearchResponse,
      error: CatalogErrors,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Search provider list prices")
      .annotate(
        OpenApi.Description,
        "Search instance types across every catalog provider: one row per product priced at the " +
          "requested rate type in the region chosen for each provider. Filters narrow by provider, " +
          "service, specs, GPU and price; rows sort by monthly price by default.",
      )
      .annotate(SuccessDescription, "Matching catalog rows"),
    HttpApiEndpoint.get("compare", "/compare", {
      params: OrgParams,
      query: {
        vcpus: numeric("Minimum vCPUs."),
        memoryGb: numeric("Minimum memory, GB."),
        gpuCount: numeric("Minimum GPUs."),
        gpuModel: text(),
        referencePluginId: text(),
        referenceSku: text(),
        area: param(Area),
        rateType: param(RateType),
        pluginIds: csv("Comma-separated plugin ids."),
        alternatives: numeric("Runners-up per provider, 0 to 10. Default 2."),
      },
      success: PriceCatalogCompareResponse,
      error: CatalogErrors,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Compare equivalent instances across providers")
      .annotate(
        OpenApi.Description,
        "The cheapest product per provider that meets every stated spec (at least the vCPUs, " +
          "memory and GPUs asked for), in each provider's region for the area. Give the target as " +
          "specs, or name a reference product and its specs are used.",
      )
      .annotate(SuccessDescription, "Best match per provider"),
  )
  .prefix("/api/org/:orgId/price-catalog")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Price catalog") {}

export class PriceCatalogApi extends withApiDefaults(
  HttpApi.make("priceCatalog").add(PriceCatalogGroup),
) {}
