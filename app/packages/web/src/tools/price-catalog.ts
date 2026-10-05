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
import { z } from "zod";
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

const area = z
  .enum([
    "north-america",
    "south-america",
    "europe",
    "asia-pacific",
    "middle-east",
    "africa",
    "oceania",
  ])
  .optional()
  .describe(
    "Geography. Each provider is priced in its first region in this area unless `region` names one it has. Default north-america.",
  );
const rateType = z
  .enum(["on-demand", "spot", "reserved", "savings-plan"])
  .optional()
  .describe("Which published rate to quote. Default on-demand.");

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
        q: z.string().optional().describe("Free text over SKU, name, series and GPU model."),
        pluginIds: z.array(z.string()).optional().describe("Limit to these plugin ids."),
        serviceIds: z.array(z.string()).optional(),
        families: z
          .array(z.enum(["compute", "gpu", "database", "kubernetes-node", "storage"]))
          .optional(),
        region: z.string().optional().describe("Exact provider region id."),
        area,
        minVcpus: z.number().nonnegative().optional(),
        maxVcpus: z.number().nonnegative().optional(),
        minMemoryGb: z.number().nonnegative().optional(),
        maxMemoryGb: z.number().nonnegative().optional(),
        gpu: z.enum(["any", "required", "none"]).optional(),
        gpuModel: z.string().optional().describe("Substring, e.g. H100, L4, A10."),
        minGpus: z.number().nonnegative().optional(),
        maxMonthlyPrice: z.number().nonnegative().optional(),
        rateType,
        term: z.string().optional().describe("`1yr` or `3yr` for reserved / savings plan."),
        sort: z.enum(["price", "vcpus", "memory", "gpus", "name"]).optional(),
        order: z.enum(["asc", "desc"]).optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Default 25."),
        offset: z.number().int().nonnegative().optional(),
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
        vcpus: z.number().nonnegative().optional(),
        memoryGb: z.number().nonnegative().optional(),
        gpuCount: z.number().nonnegative().optional(),
        gpuModel: z.string().optional(),
        referencePluginId: z.string().optional(),
        referenceSku: z.string().optional(),
        area,
        rateType,
        pluginIds: z.array(z.string()).optional(),
        alternatives: z.number().int().min(0).max(10).optional(),
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
