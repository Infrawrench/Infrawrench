/**
 * The AWS half of the org-level price catalog: every EC2 instance type a
 * region sells, with its on-demand, Standard Reserved Instance and current
 * Spot prices.
 *
 * Sources, both reached through the transport the rest of the plugin already
 * uses (no second pricing integration):
 *
 * - **Price List Query API** (`pricing:GetProducts`, see `pricing.ts`) for
 *   specs, on-demand and reserved terms. One paged GetProducts query per
 *   region with the same "one clean row per instance type" filters the size
 *   picker uses (Linux, shared tenancy, no pre-installed software, capacity
 *   status Used). Cached per region for 24 hours: AWS republishes the EC2
 *   price list on the order of weeks.
 * - **EC2 DescribeSpotPriceHistory** (`ec2:DescribeSpotPriceHistory`, covered
 *   by the `ec2:Describe*` read grant in the generated policy) for spot.
 *   Called with `StartTime` = now, which per the API reference returns the
 *   last price change before the start time, i.e. the price in effect now,
 *   for every instance type and Availability Zone. Spot moves hourly, so it
 *   has its own one-hour cache. A refusal (no permission) drops the spot
 *   column rather than the catalog.
 *
 * Docs:
 * https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-price-list-query-api.html
 * https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeSpotPriceHistory.html
 */
import {
  normalizePriceCatalogProducts,
  type PriceCatalogPrice,
  type PriceCatalogProduct,
  type PriceCatalogRegionDeclaration,
  type PriceCatalogRequest,
  type PriceCatalogResult,
  type PriceCatalogSpecs,
  type PriceCatalogArea,
  type PriceCatalogDeclaration,
} from "@infrawrench/plugin-base";
import { AWS_REGIONS } from "./constants.js";
import type { GetProductsResponse, PriceFilter } from "./pricing.js";
import { termMatch } from "./pricing.js";
import { ensureArray } from "./xml.js";

export const AWS_PRICE_CATALOG_EC2_SERVICE = "ec2";

/** Pages of 100 products; a large region lists ~1,000 EC2 types under these filters. */
const MAX_PRODUCT_PAGES = 30;
/** Pages of 1,000 spot rows (one per type x AZ); a large region is ~5,000. */
const MAX_SPOT_PAGES = 20;
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const SPOT_TTL_MS = 60 * 60 * 1000;
/** AWS amortizes reserved upfront fees over 365-day years when it quotes an effective hourly rate. */
const HOURS_PER_YEAR = 8760;

/**
 * Coarse geography per region. Oceania is split out of `ap-` by city
 * (Sydney, Melbourne, New Zealand) so a cross-provider comparison for Oceania
 * lands on an Australian region rather than Singapore.
 */
function areaForAwsRegion(id: string): PriceCatalogArea {
  if (["ap-southeast-2", "ap-southeast-4", "ap-southeast-6"].includes(id)) return "oceania";
  if (id.startsWith("us-") || id.startsWith("ca-") || id.startsWith("mx-")) return "north-america";
  if (id.startsWith("sa-")) return "south-america";
  if (id.startsWith("eu-")) return "europe";
  if (id.startsWith("me-") || id.startsWith("il-")) return "middle-east";
  if (id.startsWith("af-")) return "africa";
  return "asia-pacific";
}

/** Every commercial region the create form offers, us-east-1 first (AWS_REGIONS order). */
export const AWS_PRICE_CATALOG_REGIONS: PriceCatalogRegionDeclaration[] = AWS_REGIONS.map((r) => ({
  id: r.id,
  label: r.location ? `${r.location} (${r.id})` : r.id,
  area: areaForAwsRegion(r.id),
}));

export const AWS_PRICE_CATALOG: PriceCatalogDeclaration = {
  requiresCredentials: true,
  permission: "pricing:GetProducts",
  source: {
    name: "AWS Price List Query API",
    url: "https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-price-list-query-api.html",
  },
  refreshHours: 24,
  services: [{ id: AWS_PRICE_CATALOG_EC2_SERVICE, label: "EC2 instances", family: "compute" }],
  regions: AWS_PRICE_CATALOG_REGIONS,
};

/** The calls this module makes, injected so the client keeps owning SigV4 and endpoints. */
export interface AwsPriceCatalogTransport {
  getProducts(body: Record<string, unknown>): Promise<GetProductsResponse>;
  /** EC2 Query API `DescribeSpotPriceHistory` in `region`, parsed from XML. */
  describeSpotPriceHistory(
    region: string,
    params: Record<string, string>,
  ): Promise<Record<string, unknown>>;
}

interface PriceDimension {
  unit?: string;
  description?: string;
  pricePerUnit?: Record<string, string>;
}

interface PriceTerm {
  effectiveDate?: string;
  termAttributes?: Record<string, string>;
  priceDimensions?: Record<string, PriceDimension>;
}

interface Ec2PriceListEntry {
  product?: { sku?: string; attributes?: Record<string, string> };
  terms?: { OnDemand?: Record<string, PriceTerm>; Reserved?: Record<string, PriceTerm> };
}

const catalogCache = new Map<string, { expiresAt: number; result: PriceCatalogResult }>();
const spotCache = new Map<
  string,
  { expiresAt: number; prices: Map<string, { usd: number; timestamp?: string }> }
>();

/** Test hook. */
export function clearAwsPriceCatalogCache(): void {
  catalogCache.clear();
  spotCache.clear();
}

/** Leading number of an attribute like `8 GiB`, `1,024 GiB` or `24 GB`; undefined for `NA`. */
function leadingNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.replace(/,/g, "").match(/^\s*(\d+(?:\.\d+)?)/);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** `EBS only`, `1 x 1900 NVMe SSD`, `8 x 1000 SSD`, `2 x 7500 HDD`. */
function parseStorage(
  value: string | undefined,
): Pick<PriceCatalogSpecs, "storageGb" | "storageType"> {
  if (!value) return {};
  if (/ebs only/i.test(value)) return { storageType: "ebs-only" };
  const match = value.replace(/,/g, "").match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(.*)$/i);
  if (!match) return {};
  const storageGb = Number(match[1]) * Number(match[2]);
  const kind = (match[3] ?? "").trim().toLowerCase();
  return {
    ...(Number.isFinite(storageGb) && storageGb > 0 ? { storageGb } : {}),
    ...(kind ? { storageType: kind } : {}),
  };
}

function architectureFor(attrs: Record<string, string>): string | undefined {
  const processor = attrs["physicalProcessor"] ?? "";
  if (/graviton|arm|apple/i.test(processor)) return "arm64";
  if (/64-bit/.test(attrs["processorArchitecture"] ?? "") || /intel|amd/i.test(processor)) {
    return "x86_64";
  }
  return undefined;
}

/** Spec columns from one product's attributes. Exported for tests. */
export function ec2SpecsFromAttributes(attrs: Record<string, string>): PriceCatalogSpecs {
  const vcpus = leadingNumber(attrs["vcpu"]);
  const memoryGb = leadingNumber(attrs["memory"]);
  const gpuCount = leadingNumber(attrs["gpu"]);
  // The price list's `gpuMemory` is the instance's total across every GPU
  // (p4d.24xlarge: 320 for 8 x A100 40 GB); the catalog field is per GPU.
  const gpuMemoryTotal = leadingNumber(attrs["gpuMemory"]);
  const architecture = architectureFor(attrs);
  const network = attrs["networkPerformance"];
  return {
    ...(vcpus != null ? { vcpus } : {}),
    ...(memoryGb != null ? { memoryGb } : {}),
    ...(gpuCount ? { gpuCount } : {}),
    ...(gpuCount && gpuMemoryTotal ? { gpuMemoryGb: gpuMemoryTotal / gpuCount } : {}),
    ...parseStorage(attrs["storage"]),
    ...(architecture ? { architecture } : {}),
    ...(network && network !== "NA" ? { network } : {}),
  };
}

function usd(dim: PriceDimension): number {
  return Number(dim.pricePerUnit?.["USD"] ?? "");
}

function isHourly(dim: PriceDimension): boolean {
  return /^hrs?$/i.test(dim.unit ?? "");
}

/** On-demand + reserved prices from one product's terms. Exported for tests. */
export function ec2PricesFromTerms(
  region: string,
  terms: Ec2PriceListEntry["terms"],
): PriceCatalogPrice[] {
  const prices: PriceCatalogPrice[] = [];
  for (const term of Object.values(terms?.OnDemand ?? {})) {
    const hourly = Object.values(term.priceDimensions ?? {}).find(isHourly);
    if (!hourly) continue;
    const amount = usd(hourly);
    // A zero on-demand row is a placeholder, not a free instance.
    if (!Number.isFinite(amount) || amount <= 0) continue;
    prices.push({
      region,
      rateType: "on-demand",
      unit: "hour",
      amount,
      currency: "USD",
      ...(term.effectiveDate ? { effectiveDate: term.effectiveDate } : {}),
    });
    break;
  }

  for (const term of Object.values(terms?.Reserved ?? {})) {
    const attrs = term.termAttributes ?? {};
    // Only Standard RIs. Convertible RIs are priced as separate terms with
    // the same length and payment option, and a price row has no field to
    // tell the two apart; a Convertible row beside a Standard one would read
    // as a duplicate with a different price.
    if (attrs["OfferingClass"] && attrs["OfferingClass"] !== "standard") continue;
    const lease = attrs["LeaseContractLength"];
    const years = lease === "1yr" ? 1 : lease === "3yr" ? 3 : null;
    if (!years) continue;
    const dims = Object.values(term.priceDimensions ?? {});
    const hourlyDim = dims.find(isHourly);
    const upfrontDim = dims.find((d) => /quantity/i.test(d.unit ?? ""));
    const hourlyFee = hourlyDim ? usd(hourlyDim) : 0;
    const upfrontFee = upfrontDim ? usd(upfrontDim) : 0;
    if (!Number.isFinite(hourlyFee) || !Number.isFinite(upfrontFee)) continue;
    if (!hourlyDim && !upfrontDim) continue;
    // Effective hourly rate, which is what makes reserved comparable with
    // on-demand in one column:
    // - No Upfront: the `Hrs` dimension alone.
    // - Partial Upfront: the `Hrs` fee plus the `Quantity` (upfront) fee
    //   spread over every hour of the term.
    // - All Upfront: the upfront fee spread over the term (its `Hrs` fee is 0).
    // Term hours are 8,760 per year, the 365-day year AWS's own effective
    // hourly figures use.
    const amount = hourlyFee + upfrontFee / (years * HOURS_PER_YEAR);
    prices.push({
      region,
      rateType: "reserved",
      unit: "hour",
      amount,
      currency: "USD",
      term: lease!,
      ...(attrs["PurchaseOption"] ? { paymentOption: attrs["PurchaseOption"] } : {}),
      ...(term.effectiveDate ? { effectiveDate: term.effectiveDate } : {}),
    });
  }
  return prices;
}

/** One catalog product from a GetProducts `PriceList` entry. Exported for tests. */
export function ec2ProductFromPriceListEntry(
  region: string,
  raw: string,
): { product: PriceCatalogProduct; operation?: string } | null {
  let entry: Ec2PriceListEntry;
  try {
    entry = JSON.parse(raw) as Ec2PriceListEntry;
  } catch {
    return null;
  }
  const attrs = entry.product?.attributes ?? {};
  const instanceType = attrs["instanceType"];
  if (!instanceType) return null;
  const specs = ec2SpecsFromAttributes(attrs);
  const series = instanceType.split(".")[0];
  return {
    ...(attrs["operation"] ? { operation: attrs["operation"] } : {}),
    product: {
      sku: instanceType,
      name: instanceType,
      serviceId: AWS_PRICE_CATALOG_EC2_SERVICE,
      family: specs.gpuCount ? "gpu" : "compute",
      ...(series ? { series } : {}),
      specs,
      prices: ec2PricesFromTerms(region, entry.terms),
      // Keyed like the ec2-instance create form (create-handlers/compute.ts).
      estimate: {
        resourceTypeId: "ec2-instance",
        fields: { region: "{region}", instanceType },
      },
    },
  };
}

function ec2Filters(region: string): PriceFilter[] {
  return [
    termMatch("regionCode", region),
    termMatch("tenancy", "Shared"),
    termMatch("operatingSystem", "Linux"),
    termMatch("preInstalledSw", "NA"),
    termMatch("capacitystatus", "Used"),
  ];
}

async function fetchOnDemandAndReserved(
  transport: AwsPriceCatalogTransport,
  region: string,
): Promise<PriceCatalogResult> {
  const byType = new Map<string, { product: PriceCatalogProduct; operation?: string }>();
  let nextToken: string | undefined;
  let pages = 0;
  do {
    const response = await transport.getProducts({
      ServiceCode: "AmazonEC2",
      Filters: ec2Filters(region),
      FormatVersion: "aws_v1",
      MaxResults: 100,
      ...(nextToken ? { NextToken: nextToken } : {}),
    });
    pages++;
    for (const raw of response.PriceList ?? []) {
      const parsed = ec2ProductFromPriceListEntry(region, raw);
      if (!parsed || parsed.product.prices.length === 0) continue;
      const existing = byType.get(parsed.product.sku);
      // Under these filters an instance type can still appear once per
      // licensing operation; the plain `RunInstances` row is the console's
      // Linux price, so it wins over any variant.
      if (
        !existing ||
        (existing.operation !== "RunInstances" && parsed.operation === "RunInstances")
      ) {
        byType.set(parsed.product.sku, parsed);
      }
    }
    nextToken = response.NextToken || undefined;
  } while (nextToken && pages < MAX_PRODUCT_PAGES);

  return {
    products: [...byType.values()].map((v) => v.product),
    ...(nextToken ? { truncated: true } : {}),
  };
}

/**
 * Current Linux spot price per instance type in `region`: the lowest across
 * the region's Availability Zones, since a spot request that does not pin a
 * zone can land in the cheapest one. Throws on a refused call.
 */
async function fetchSpotPrices(
  transport: AwsPriceCatalogTransport,
  region: string,
): Promise<Map<string, { usd: number; timestamp?: string }>> {
  const cached = spotCache.get(region);
  if (cached && cached.expiresAt > Date.now()) return cached.prices;

  const prices = new Map<string, { usd: number; timestamp?: string }>();
  const startTime = new Date().toISOString();
  let nextToken: string | undefined;
  let pages = 0;
  do {
    const data = await transport.describeSpotPriceHistory(region, {
      "ProductDescription.1": "Linux/UNIX",
      StartTime: startTime,
      MaxResults: "1000",
      ...(nextToken ? { NextToken: nextToken } : {}),
    });
    pages++;
    const set = data["spotPriceHistorySet"] as { item?: unknown } | undefined;
    for (const item of ensureArray(set?.item as Record<string, unknown>[] | undefined)) {
      const type = typeof item["instanceType"] === "string" ? item["instanceType"] : "";
      const price = Number(item["spotPrice"]);
      if (!type || !Number.isFinite(price) || price <= 0) continue;
      const timestamp = typeof item["timestamp"] === "string" ? item["timestamp"] : undefined;
      const existing = prices.get(type);
      if (!existing || price < existing.usd) {
        prices.set(type, { usd: price, ...(timestamp ? { timestamp } : {}) });
      }
    }
    const token = data["nextToken"];
    nextToken = typeof token === "string" && token.length > 0 ? token : undefined;
  } while (nextToken && pages < MAX_SPOT_PAGES);

  spotCache.set(region, { expiresAt: Date.now() + SPOT_TTL_MS, prices });
  return prices;
}

/** The credentialed `fetchPriceCatalog`. */
export async function fetchAwsPriceCatalog(
  transport: AwsPriceCatalogTransport,
  request: PriceCatalogRequest,
): Promise<PriceCatalogResult> {
  if (request.serviceId !== AWS_PRICE_CATALOG_EC2_SERVICE) return { products: [] };
  const region = request.region || AWS_PRICE_CATALOG_REGIONS[0]!.id;

  let base = catalogCache.get(region);
  if (!base || base.expiresAt <= Date.now()) {
    // Not caught: a refused GetProducts is the "this account cannot price"
    // signal the host turns into the permission hint.
    const result = await fetchOnDemandAndReserved(transport, region);
    base = { expiresAt: Date.now() + CATALOG_TTL_MS, result };
    catalogCache.set(region, base);
  }

  let spot = new Map<string, { usd: number; timestamp?: string }>();
  try {
    spot = await fetchSpotPrices(transport, region);
  } catch {
    // No ec2:DescribeSpotPriceHistory (or a transient failure): the catalog
    // still answers with on-demand and reserved; not cached, so it retries.
  }

  const products = base.result.products.map((product) => {
    const s = spot.get(product.sku);
    if (!s) return product;
    return {
      ...product,
      prices: [
        ...product.prices,
        {
          region,
          rateType: "spot" as const,
          unit: "hour" as const,
          amount: s.usd,
          currency: "USD",
          ...(s.timestamp ? { effectiveDate: s.timestamp } : {}),
        },
      ],
    };
  });

  return {
    products: normalizePriceCatalogProducts(products),
    ...(base.result.truncated ? { truncated: true } : {}),
  };
}
