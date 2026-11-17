/**
 * Price catalog tools: the MCP/chat view of the Price catalog tab. Read-only.
 *
 * These are the tools that let an assistant answer "what's the cheapest 8 vCPU
 * / 32 GB box in Europe?" or "what would this GPU workload cost on each
 * provider?" from the providers' own published list prices instead of from
 * its training data, which is out of date by construction. A row's `estimate`
 * names the create form and fields a follow-up `create_resource` (or the
 * user's own create form) would use.
 */
import { Schema } from "effect";
import {
  getPriceCatalogService,
  PriceCatalogNotFoundError,
  PriceCatalogQueryError,
} from "@infrawrench/server-core/price-catalog";
import {
  normalizePriceCatalogCompareQuery,
  normalizePriceCatalogSearchQuery,
} from "@infrawrench/client-core";
import { err, ok, type ToolDefinition } from "./types";

const area = Schema.optionalKey(
  Schema.Literals([
    "north-america",
    "south-america",
    "europe",
    "asia-pacific",
    "middle-east",
    "africa",
    "oceania",
  ]).annotate({
    description:
      "Geography. Each provider is priced in its first region in this area unless `region` names one it has. Default north-america.",
  }),
);
const rateType = Schema.optionalKey(
  Schema.Literals(["on-demand", "spot", "reserved", "savings-plan"]).annotate({
    description: "Which published rate to quote. Default on-demand.",
  }),
);

export function priceCatalogTools(): ToolDefinition[] {
  return [
    {
      name: "list_price_catalog_providers",
      title: "List price catalog providers",
      description:
        "Providers whose published list prices the price catalog covers, with each one's " +
        "services, regions (id, label, area), source, refresh cadence and state. " +
        "`no-account` means the provider's price API needs credentials and the org has no " +
        "account on it. Use this to find valid pluginIds, serviceIds and region ids before " +
        "search_price_catalog.",
      inputSchema: {},
      risk: "read",
      permission: "resources:read",
      handler: async (_input, auth) =>
        ok({ providers: await getPriceCatalogService().listProviders(auth.organizationId) }),
    },
    {
      name: "search_price_catalog",
      title: "Search the price catalog",
      description:
        "Search provider list prices (instance types / sizes with vCPU, memory, GPU and " +
        "storage specs) across every catalog provider, one row per product at the chosen rate " +
        "type in each provider's region. Filter by provider, service, specs, GPU model and " +
        "max monthly price; sort by price (default), vcpus, memory, gpus or name. Prices are " +
        "the providers' published list prices, never the org's negotiated rates. `comparable` " +
        "is the monthly figure in the org's display currency when one is configured. Check " +
        "`providers[].state` before concluding a provider has nothing: `no-account`, " +
        "`loading` and `error` all mean it was not searched.",
      inputSchema: {
        q: Schema.optionalKey(
          Schema.String.annotate({
            description: "Free text over SKU, name, series and GPU model.",
          }),
        ),
        pluginIds: Schema.optionalKey(
          Schema.Array(Schema.String).annotate({ description: "Limit to these plugin ids." }),
        ),
        serviceIds: Schema.optionalKey(Schema.Array(Schema.String)),
        families: Schema.optionalKey(
          Schema.Array(
            Schema.Literals(["compute", "gpu", "database", "kubernetes-node", "storage"]),
          ),
        ),
        region: Schema.optionalKey(
          Schema.String.annotate({ description: "Exact provider region id." }),
        ),
        area,
        minVcpus: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
        maxVcpus: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
        minMemoryGb: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
        maxMemoryGb: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
        gpu: Schema.optionalKey(Schema.Literals(["any", "required", "none"])),
        gpuModel: Schema.optionalKey(
          Schema.String.annotate({ description: "Substring, e.g. H100, L4, A10." }),
        ),
        minGpus: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
        maxMonthlyPrice: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
        rateType,
        term: Schema.optionalKey(
          Schema.String.annotate({ description: "`1yr` or `3yr` for reserved / savings plan." }),
        ),
        sort: Schema.optionalKey(Schema.Literals(["price", "vcpus", "memory", "gpus", "name"])),
        order: Schema.optionalKey(Schema.Literals(["asc", "desc"])),
        limit: Schema.optionalKey(
          Schema.Int.check(
            Schema.isGreaterThanOrEqualTo(1),
            Schema.isLessThanOrEqualTo(200),
          ).annotate({ description: "Default 25." }),
        ),
        offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      },
      risk: "read",
      permission: "resources:read",
      handler: async (input, auth) => {
        const raw = input as Record<string, unknown>;
        const query = normalizePriceCatalogSearchQuery({ limit: 25, ...raw });
        return ok(await getPriceCatalogService().search(auth.organizationId, query));
      },
    },
    {
      name: "compare_instance_prices",
      title: "Compare equivalent instances across providers",
      description:
        "For a target spec (at least `vcpus`, `memoryGb`, `gpuCount`, optionally a " +
        "`gpuModel`), or a reference product (`referencePluginId` + `referenceSku`) whose " +
        "specs are used, return the cheapest product per provider that meets every stated " +
        "spec, plus runners-up, priced in each provider's region for the area. Providers are " +
        "ordered cheapest first. Equivalence is by published specs only, never by name.",
      inputSchema: {
        vcpus: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
        memoryGb: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
        gpuCount: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
        gpuModel: Schema.optionalKey(Schema.String),
        referencePluginId: Schema.optionalKey(Schema.String),
        referenceSku: Schema.optionalKey(Schema.String),
        area,
        rateType,
        pluginIds: Schema.optionalKey(Schema.Array(Schema.String)),
        alternatives: Schema.optionalKey(
          Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(10)),
        ),
      },
      risk: "read",
      permission: "resources:read",
      handler: async (input, auth) => {
        const query = normalizePriceCatalogCompareQuery(input as Record<string, unknown>);
        try {
          return ok(await getPriceCatalogService().compare(auth.organizationId, query));
        } catch (e) {
          if (e instanceof PriceCatalogQueryError || e instanceof PriceCatalogNotFoundError) {
            return err(e.message);
          }
          throw e;
        }
      },
    },
  ];
}
