/**
 * The price catalog contract: a provider's published list prices, normalized
 * into one shape every host can search, filter and compare.
 *
 * Plugins already hold price tables for three features: live cost estimates
 * (`estimateCost`), right-sizing (the size catalogs behind "Oversized") and
 * Kubernetes node pricing. Each of those asks one narrow question ("what does
 * *this* configuration cost?"). The catalog asks the browsing question
 * instead ("what could I run, and what would it cost?") over the same
 * sources, so a plugin implements it by re-shaping the tables it already
 * fetches rather than by adding a second pricing integration.
 *
 * Two halves, the same split `quotas` and `statusFeed` make:
 *
 * - The manifest's {@link PriceCatalogDeclaration} says what the plugin can
 *   price, where the numbers come from and whether credentials are needed. It
 *   is data, Zod-validated, and answerable without an account.
 * - The fetch lives on the **Plugin** (`fetchPriceCatalog`) when the
 *   provider's price source is public, and on the **PluginClient** when it
 *   needs credentials (AWS's Price List Query API, for one). The host reads
 *   `requiresCredentials` to know which to call, and for a credentialed
 *   catalog borrows any of the org's accounts on that plugin.
 *
 * **Every figure is the provider's published list price.** A plugin must not
 * invent a rate, scale one region's price to another, or fill a gap from
 * memory: a catalog is only useful if a number in it can be checked against
 * the provider's own page. A product the source does not price is simply
 * absent, and a rate type the source does not publish (spot on a provider
 * with no spot market) is absent rather than zero.
 */

/** What kind of thing a product is. Drives which spec columns a surface shows. */
export type PriceCatalogProductFamily =
  "compute" | "gpu" | "database" | "kubernetes-node" | "storage";

/**
 * How a rate is bought.
 *
 * - `on-demand`: pay-as-you-go list price.
 * - `spot`: interruptible capacity (AWS Spot, Azure Spot, GCP Spot VMs). The
 *   price moves; the catalog quotes what the source published at fetch time.
 * - `reserved`: a term commitment for a specific product (reserved instances,
 *   Azure reservations, GCP resource-based committed use).
 * - `savings-plan`: a spend commitment priced per product (AWS and Azure
 *   savings plans).
 */
export type PriceRateType = "on-demand" | "spot" | "reserved" | "savings-plan";

/** The billing unit a price is quoted in. */
export type PriceUnit = "hour" | "month" | "gb-month";

export interface PriceCatalogSpecs {
  vcpus?: number;
  memoryGb?: number;
  gpuCount?: number;
  /** The provider's GPU model name, e.g. `NVIDIA H100`. */
  gpuModel?: string;
  /** Memory per GPU, in GB. */
  gpuMemoryGb?: number;
  /** Included local or boot storage, in GB. */
  storageGb?: number;
  /** `ssd`, `nvme`, `hdd`, `ebs-only`...: free text, the provider's own word. */
  storageType?: string;
  /** `x86_64`, `arm64`. */
  architecture?: string;
  /** Included network bandwidth or transfer, in the provider's wording. */
  network?: string;
}

/**
 * Where a price came from, for the "can I check this?" link on every row.
 * Optional fields only: a static table has no URL to fetch.
 */
export interface PriceCatalogPrice {
  /** Provider region id (`us-east-1`, `eastus`, `fsn1`). */
  region: string;
  rateType: PriceRateType;
  unit: PriceUnit;
  /** Price per `unit`, in `currency`. Must be finite and >= 0. */
  amount: number;
  /** ISO 4217. */
  currency: string;
  /**
   * Commitment term for `reserved` / `savings-plan`: `1yr`, `3yr`. Absent for
   * on-demand and spot.
   */
  term?: string;
  /**
   * Payment option for commitments in the provider's wording: `No Upfront`,
   * `All Upfront`. Absent when the source does not split by it.
   */
  paymentOption?: string;
  /**
   * When the provider says this rate took effect (ISO 8601 date or datetime).
   * Absent when the source does not say: never the fetch time pretending to
   * be an effective date.
   */
  effectiveDate?: string;
}

export interface PriceCatalogProduct {
  /** Plugin-scoped stable id. Use the provider SKU / size slug. */
  sku: string;
  /** Display name, usually the same as the SKU (`m7i.large`, `CX22`). */
  name: string;
  /** One of the declaration's service ids. */
  serviceId: string;
  family: PriceCatalogProductFamily;
  /** Provider series / family label: `m7i`, `Dsv5`, `N2`, `Shared vCPU`. */
  series?: string;
  specs: PriceCatalogSpecs;
  prices: PriceCatalogPrice[];
  /**
   * How to open this product in the plugin's create form, so a surface can
   * offer "use in estimate". `fields` are keyed the way the create form keys
   * them (the `estimateCost` rule); `{region}` in a value is replaced with
   * the price's region by the host.
   */
  estimate?: {
    resourceTypeId: string;
    fields: Record<string, string>;
  };
}

/** One request to a plugin: one service, optionally one region. */
export interface PriceCatalogRequest {
  serviceId: string;
  /**
   * The region to price. Absent means the plugin's default region for
   * region-scoped sources; a source that prices every region in one call
   * (`regionScoped: false`) may ignore it and return them all.
   */
  region?: string;
}

export interface PriceCatalogResult {
  products: PriceCatalogProduct[];
  /**
   * True when the source was cut short (a page limit was hit). The host
   * says so rather than presenting a clipped list as complete.
   */
  truncated?: boolean;
}

export interface PriceCatalogServiceDeclaration {
  id: string;
  label: string;
  family: PriceCatalogProductFamily;
}

export interface PriceCatalogRegionDeclaration {
  id: string;
  label: string;
  /**
   * Coarse geography, so "compare equivalent instances" can pick a region per
   * provider without the user learning every provider's region names.
   */
  area: PriceCatalogArea;
}

export type PriceCatalogArea =
  | "north-america"
  | "south-america"
  | "europe"
  | "asia-pacific"
  | "middle-east"
  | "africa"
  | "oceania";

export const PRICE_CATALOG_AREAS: readonly PriceCatalogArea[] = [
  "north-america",
  "europe",
  "asia-pacific",
  "south-america",
  "oceania",
  "middle-east",
  "africa",
];

export interface PriceCatalogDeclaration {
  /**
   * True when fetching needs an account's credentials (the fetch is then
   * `PluginClient.fetchPriceCatalog`); false when the source is public (the
   * fetch is `Plugin.fetchPriceCatalog`).
   */
  requiresCredentials: boolean;
  /**
   * The provider permission a credentialed fetch needs, in the provider's own
   * wording (`pricing:GetProducts`), shown when no account can fetch.
   */
  permission?: string;
  /** The provider's price source, named for the coverage note. */
  source: { name: string; url: string };
  /**
   * How long a fetched result stays fresh, in hours. Price lists change on
   * the order of weeks; spot prices on the order of hours.
   */
  refreshHours: number;
  /** False when one fetch returns every region at once. Default true. */
  regionScoped?: boolean;
  services: PriceCatalogServiceDeclaration[];
  /**
   * Regions in preference order: the first region of an area is the one a
   * cross-provider comparison uses for it, and `regions[0]` is the default.
   */
  regions: PriceCatalogRegionDeclaration[];
}

/** Hours in the month every estimate assumes (the `estimateCost` convention). */
export const PRICE_CATALOG_HOURS_PER_MONTH = 730;

/**
 * A price's monthly equivalent, or null when the unit cannot be turned into a
 * per-instance month (a per-GB storage rate).
 */
export function monthlyPriceAmount(
  price: Pick<PriceCatalogPrice, "amount" | "unit">,
): number | null {
  if (price.unit === "hour") return price.amount * PRICE_CATALOG_HOURS_PER_MONTH;
  if (price.unit === "month") return price.amount;
  return null;
}

/**
 * Drop prices a host cannot show honestly (non-finite, negative, missing
 * currency) and products left with no price. Plugins call this on their way
 * out so every host sees the same cleaned result.
 */
export function normalizePriceCatalogProducts(
  products: PriceCatalogProduct[],
): PriceCatalogProduct[] {
  const out: PriceCatalogProduct[] = [];
  const seen = new Set<string>();
  for (const product of products) {
    if (!product.sku || seen.has(product.sku)) continue;
    const prices = product.prices.filter(
      (p) =>
        Number.isFinite(p.amount) &&
        p.amount >= 0 &&
        typeof p.currency === "string" &&
        p.currency.length === 3 &&
        typeof p.region === "string" &&
        p.region.length > 0,
    );
    if (prices.length === 0) continue;
    seen.add(product.sku);
    out.push({ ...product, prices });
  }
  return out;
}
