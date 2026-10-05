/**
 * Price catalog: the wire contract and the pure search/compare logic every
 * surface shares (the server's routes, the MCP tools, the CLI's text output,
 * and the web/desktop panel).
 *
 * The data comes from the plugins' `priceCatalog` capability
 * (`plugin-base/src/price-catalog.ts`): each provider's published list
 * prices, normalized. Everything in this file is a function of its arguments,
 * no network and no clock beyond what the caller passes, so filtering,
 * sorting and "equivalent instance" matching behave identically wherever they
 * run.
 *
 * Two rules carry through:
 *
 * - **List prices, not bills.** Nothing here applies an org's discounts; the
 *   catalog says what the provider publishes and links to where.
 * - **No invented equivalence.** Comparing across providers matches on
 *   published specs (vCPU, memory, GPU) and never on names: an `m7i.large`
 *   and a `CX22` are compared because both state 2 vCPUs, not because a table
 *   somewhere says they are the same class.
 */
import type {
  PriceCatalogArea,
  PriceCatalogPrice,
  PriceCatalogProduct,
  PriceCatalogProductFamily,
  PriceCatalogRegionDeclaration,
  PriceCatalogServiceDeclaration,
  PriceCatalogSpecs,
  PriceRateType,
} from "@infrawrench/plugin-base";

export type {
  PriceCatalogArea,
  PriceCatalogPrice,
  PriceCatalogProduct,
  PriceCatalogProductFamily,
  PriceCatalogRegionDeclaration,
  PriceCatalogServiceDeclaration,
  PriceCatalogSpecs,
  PriceRateType,
};

export const PRICE_CATALOG_HOURS = 730;

export const PRICE_RATE_TYPES: readonly PriceRateType[] = [
  "on-demand",
  "spot",
  "reserved",
  "savings-plan",
];

export const PRICE_RATE_TYPE_LABELS: Record<PriceRateType, string> = {
  "on-demand": "On-demand",
  spot: "Spot",
  reserved: "Reserved",
  "savings-plan": "Savings plan",
};

export const PRICE_CATALOG_AREA_LIST: readonly PriceCatalogArea[] = [
  "north-america",
  "europe",
  "asia-pacific",
  "south-america",
  "oceania",
  "middle-east",
  "africa",
];

export const PRICE_CATALOG_AREA_LABELS: Record<PriceCatalogArea, string> = {
  "north-america": "North America",
  "south-america": "South America",
  europe: "Europe",
  "asia-pacific": "Asia Pacific",
  "middle-east": "Middle East",
  africa: "Africa",
  oceania: "Oceania",
};

export const PRICE_CATALOG_FAMILY_LABELS: Record<PriceCatalogProductFamily, string> = {
  compute: "Compute",
  gpu: "GPU",
  database: "Database",
  "kubernetes-node": "Kubernetes node",
  storage: "Storage",
};

export const DEFAULT_PRICE_CATALOG_AREA: PriceCatalogArea = "north-america";
export const PRICE_CATALOG_MAX_LIMIT = 500;
export const PRICE_CATALOG_DEFAULT_LIMIT = 100;

/** Why a provider contributed nothing to a response. */
export type PriceCatalogProviderState =
  /** Fetched (or served from cache) and contributed rows. */
  | "ready"
  /** Needs credentials and the org has no account on this plugin. */
  | "no-account"
  /** Declares no region in the requested area. */
  | "no-region"
  /** The first fetch is still running; ask again shortly. */
  | "loading"
  /** The fetch failed; `error` says how. */
  | "error";

export interface PriceCatalogProviderStatus {
  pluginId: string;
  pluginName: string;
  requiresCredentials: boolean;
  /** Provider permission a credentialed fetch needs, e.g. `pricing:GetProducts`. */
  permission: string | null;
  source: { name: string; url: string };
  refreshHours: number;
  services: PriceCatalogServiceDeclaration[];
  regions: PriceCatalogRegionDeclaration[];
  state: PriceCatalogProviderState;
  /** The region this response priced for this provider, when one was chosen. */
  region: string | null;
  error: string | null;
  /** When the served data was fetched from the provider (ISO). */
  fetchedAt: string | null;
  truncated: boolean;
}

/** A monthly figure in the org's display currency, when it could be converted. */
export interface PriceCatalogComparable {
  amount: number;
  currency: string;
}

/** One product priced at one rate in one region: the unit every surface lists. */
export interface PriceCatalogRow {
  pluginId: string;
  pluginName: string;
  serviceId: string;
  serviceLabel: string;
  sku: string;
  name: string;
  family: PriceCatalogProductFamily;
  series: string | null;
  specs: PriceCatalogSpecs;
  region: string;
  regionLabel: string;
  price: PriceCatalogPrice;
  /** `price` as a 730-hour month, or null for a per-GB unit. */
  monthlyAmount: number | null;
  /**
   * `monthlyAmount` in the comparison currency: the price's own currency when
   * it already is the comparison currency, converted at the org's stated rate
   * otherwise, null when there is no rate. Sorting uses it.
   */
  comparable: PriceCatalogComparable | null;
  /** The product's other prices in the same region (spot, reserved terms...). */
  otherPrices: PriceCatalogPrice[];
  /** Create-form prefill for "use in estimate", with the region filled in. */
  estimate: { resourceTypeId: string; fields: Record<string, string> } | null;
}

export type PriceCatalogSort = "price" | "vcpus" | "memory" | "gpus" | "name";
export type PriceCatalogGpuFilter = "any" | "required" | "none";

export interface PriceCatalogSearchQuery {
  /** Free text over sku, name, series and GPU model. */
  q?: string | undefined;
  pluginIds?: string[] | undefined;
  serviceIds?: string[] | undefined;
  families?: PriceCatalogProductFamily[] | undefined;
  /** An exact provider region. Only applies to providers that declare it. */
  region?: string | undefined;
  /** Used for every provider that does not declare `region`. */
  area?: PriceCatalogArea | undefined;
  minVcpus?: number | undefined;
  maxVcpus?: number | undefined;
  minMemoryGb?: number | undefined;
  maxMemoryGb?: number | undefined;
  gpu?: PriceCatalogGpuFilter | undefined;
  /** Case-insensitive substring of the GPU model (`H100`, `L4`). */
  gpuModel?: string | undefined;
  minGpus?: number | undefined;
  /** Upper bound on the comparable monthly price. */
  maxMonthlyPrice?: number | undefined;
  rateType?: PriceRateType | undefined;
  /** For reserved / savings-plan: `1yr`, `3yr`. */
  term?: string | undefined;
  sort?: PriceCatalogSort | undefined;
  order?: "asc" | "desc" | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface PriceCatalogSearchResponse {
  rows: PriceCatalogRow[];
  /** Rows matching before `limit`/`offset`. */
  total: number;
  offset: number;
  limit: number;
  area: PriceCatalogArea;
  rateType: PriceRateType;
  providers: PriceCatalogProviderStatus[];
  /** The currency `comparable` is in, or null when no conversion is configured. */
  displayCurrency: string | null;
  /** Native currencies present in the matching rows. */
  currencies: string[];
  /** True when rows sort across currencies with no common comparable figure. */
  mixedCurrencies: boolean;
  /** GPU models present in the scanned products, for the filter's picker. */
  gpuModels: string[];
  generatedAt: string;
}

export interface PriceCatalogCompareQuery {
  vcpus?: number | undefined;
  memoryGb?: number | undefined;
  gpuCount?: number | undefined;
  gpuModel?: string | undefined;
  /** Take the target specs from a catalog product instead. */
  reference?: { pluginId: string; sku: string } | undefined;
  area?: PriceCatalogArea | undefined;
  rateType?: PriceRateType | undefined;
  pluginIds?: string[] | undefined;
  /** Runners-up per provider beside the best match. Default 2, max 10. */
  alternatives?: number | undefined;
}

export interface PriceCatalogCompareTarget {
  vcpus: number | null;
  memoryGb: number | null;
  gpuCount: number | null;
  gpuModel: string | null;
}

export interface PriceCatalogCompareProvider {
  pluginId: string;
  pluginName: string;
  region: string | null;
  regionLabel: string | null;
  state: PriceCatalogProviderState;
  error: string | null;
  /** The cheapest product that meets every stated spec, or null. */
  best: PriceCatalogRow | null;
  alternatives: PriceCatalogRow[];
}

export interface PriceCatalogCompareResponse {
  target: PriceCatalogCompareTarget;
  /** Set when the target came from a reference product. */
  reference: PriceCatalogRow | null;
  area: PriceCatalogArea;
  rateType: PriceRateType;
  /** Cheapest first; providers with no match last. */
  providers: PriceCatalogCompareProvider[];
  displayCurrency: string | null;
  mixedCurrencies: boolean;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Query normalization (shared by the route's query string and the MCP tools)
// ---------------------------------------------------------------------------

function num(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function list(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const out = raw.map((v) => String(v).trim()).filter((v) => v.length > 0);
  return out.length > 0 ? out : undefined;
}

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isPriceCatalogArea(value: unknown): value is PriceCatalogArea {
  return typeof value === "string" && (PRICE_CATALOG_AREA_LIST as string[]).includes(value);
}

export function isPriceRateType(value: unknown): value is PriceRateType {
  return typeof value === "string" && (PRICE_RATE_TYPES as string[]).includes(value);
}

const FAMILIES: readonly PriceCatalogProductFamily[] = [
  "compute",
  "gpu",
  "database",
  "kubernetes-node",
  "storage",
];
const SORTS: readonly PriceCatalogSort[] = ["price", "vcpus", "memory", "gpus", "name"];

/**
 * Coerce a loose bag (query-string values, an MCP tool's input) into a
 * search query. Unknown values are dropped rather than rejected: a filter
 * the server does not understand narrows nothing, which is visible, whereas
 * a 400 for a typo in a URL is not helpful.
 */
export function normalizePriceCatalogSearchQuery(
  raw: Record<string, unknown>,
): PriceCatalogSearchQuery {
  const gpu = str(raw["gpu"]);
  const sort = str(raw["sort"]);
  const order = str(raw["order"]);
  const families = list(raw["families"] ?? raw["family"])?.filter(
    (f): f is PriceCatalogProductFamily => (FAMILIES as string[]).includes(f),
  );
  const limit = num(raw["limit"]);
  return {
    q: str(raw["q"]),
    pluginIds: list(raw["pluginIds"] ?? raw["provider"] ?? raw["providers"]),
    serviceIds: list(raw["serviceIds"] ?? raw["service"]),
    families: families && families.length > 0 ? families : undefined,
    region: str(raw["region"]),
    area: isPriceCatalogArea(raw["area"]) ? raw["area"] : undefined,
    minVcpus: num(raw["minVcpus"]),
    maxVcpus: num(raw["maxVcpus"]),
    minMemoryGb: num(raw["minMemoryGb"]),
    maxMemoryGb: num(raw["maxMemoryGb"]),
    gpu: gpu === "required" || gpu === "none" || gpu === "any" ? gpu : undefined,
    gpuModel: str(raw["gpuModel"]),
    minGpus: num(raw["minGpus"]),
    maxMonthlyPrice: num(raw["maxMonthlyPrice"] ?? raw["maxPrice"]),
    rateType: isPriceRateType(raw["rateType"]) ? raw["rateType"] : undefined,
    term: str(raw["term"]),
    sort: sort && (SORTS as string[]).includes(sort) ? (sort as PriceCatalogSort) : undefined,
    order: order === "asc" || order === "desc" ? order : undefined,
    limit:
      limit !== undefined
        ? Math.max(1, Math.min(PRICE_CATALOG_MAX_LIMIT, Math.floor(limit)))
        : undefined,
    offset: num(raw["offset"]) !== undefined ? Math.floor(num(raw["offset"])!) : undefined,
  };
}

export function normalizePriceCatalogCompareQuery(
  raw: Record<string, unknown>,
): PriceCatalogCompareQuery {
  const referencePlugin = str(raw["referencePluginId"]);
  const referenceSku = str(raw["referenceSku"]);
  const nested = raw["reference"];
  const reference =
    referencePlugin && referenceSku
      ? { pluginId: referencePlugin, sku: referenceSku }
      : nested && typeof nested === "object"
        ? (() => {
            const r = nested as Record<string, unknown>;
            const pluginId = str(r["pluginId"]);
            const sku = str(r["sku"]);
            return pluginId && sku ? { pluginId, sku } : undefined;
          })()
        : undefined;
  const alternatives = num(raw["alternatives"]);
  return {
    vcpus: num(raw["vcpus"]),
    memoryGb: num(raw["memoryGb"]),
    gpuCount: num(raw["gpuCount"]),
    gpuModel: str(raw["gpuModel"]),
    reference,
    area: isPriceCatalogArea(raw["area"]) ? raw["area"] : undefined,
    rateType: isPriceRateType(raw["rateType"]) ? raw["rateType"] : undefined,
    pluginIds: list(raw["pluginIds"] ?? raw["provider"] ?? raw["providers"]),
    alternatives: alternatives !== undefined ? Math.min(10, Math.floor(alternatives)) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Region choice
// ---------------------------------------------------------------------------

/**
 * The region a provider is priced in for a request: the requested region when
 * the provider declares it, else the provider's first declared region in the
 * area, else null (the provider sits this request out, and says so).
 */
export function resolveCatalogRegion(
  regions: PriceCatalogRegionDeclaration[],
  opts: { region?: string | undefined; area: PriceCatalogArea },
): PriceCatalogRegionDeclaration | null {
  if (opts.region) {
    const exact = regions.find((r) => r.id === opts.region);
    if (exact) return exact;
  }
  return regions.find((r) => r.area === opts.area) ?? null;
}

// ---------------------------------------------------------------------------
// Row building
// ---------------------------------------------------------------------------

export function monthlyFromPrice(price: Pick<PriceCatalogPrice, "amount" | "unit">): number | null {
  if (price.unit === "hour") return price.amount * PRICE_CATALOG_HOURS;
  if (price.unit === "month") return price.amount;
  return null;
}

/**
 * Converts a monthly amount to the comparison currency, or returns null. The
 * caller owns the rates (an org's stated exchange rates); the identity case
 * is handled here so a host with no conversion still compares one currency.
 */
export type PriceCatalogConverter = (
  amount: number,
  currency: string,
) => PriceCatalogComparable | null;

export function identityConverter(displayCurrency: string | null): PriceCatalogConverter {
  return (amount, currency) =>
    displayCurrency === null || currency === displayCurrency ? { amount, currency } : null;
}

function termRank(term: string | undefined): number {
  if (!term) return 0;
  const n = Number.parseInt(term, 10);
  return Number.isFinite(n) ? n : 99;
}

/**
 * Choose the product's price for a rate type in a region. For commitments
 * with several terms/payment options, the requested term wins, else the
 * cheapest (which is what someone asking "what does reserved cost?" means).
 */
export function selectCatalogPrice(
  prices: PriceCatalogPrice[],
  region: string,
  rateType: PriceRateType,
  term?: string | undefined,
): PriceCatalogPrice | null {
  const candidates = prices.filter(
    (p) => p.region === region && p.rateType === rateType && (!term || p.term === term),
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, p) => {
    const a = monthlyFromPrice(p) ?? p.amount;
    const b = monthlyFromPrice(best) ?? best.amount;
    if (a !== b) return a < b ? p : best;
    return termRank(p.term) < termRank(best.term) ? p : best;
  });
}

export interface BuildCatalogRowsInput {
  pluginId: string;
  pluginName: string;
  services: PriceCatalogServiceDeclaration[];
  regionLabel: string;
  region: string;
  products: PriceCatalogProduct[];
  rateType: PriceRateType;
  term?: string | undefined;
  convert: PriceCatalogConverter;
}

function fillEstimate(
  estimate: PriceCatalogProduct["estimate"],
  region: string,
): PriceCatalogRow["estimate"] {
  if (!estimate) return null;
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(estimate.fields)) {
    fields[key] = value.replaceAll("{region}", region);
  }
  return { resourceTypeId: estimate.resourceTypeId, fields };
}

/** One row per product that has a price of `rateType` in `region`. */
export function buildCatalogRows(input: BuildCatalogRowsInput): PriceCatalogRow[] {
  const serviceLabels = new Map(input.services.map((s) => [s.id, s.label]));
  const rows: PriceCatalogRow[] = [];
  for (const product of input.products) {
    const price = selectCatalogPrice(product.prices, input.region, input.rateType, input.term);
    if (!price) continue;
    const monthlyAmount = monthlyFromPrice(price);
    rows.push({
      pluginId: input.pluginId,
      pluginName: input.pluginName,
      serviceId: product.serviceId,
      serviceLabel: serviceLabels.get(product.serviceId) ?? product.serviceId,
      sku: product.sku,
      name: product.name,
      family: product.family,
      series: product.series ?? null,
      specs: product.specs,
      region: input.region,
      regionLabel: input.regionLabel,
      price,
      monthlyAmount,
      comparable: monthlyAmount === null ? null : input.convert(monthlyAmount, price.currency),
      otherPrices: product.prices.filter((p) => p.region === input.region && p !== price),
      estimate: fillEstimate(product.estimate, input.region),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Filtering and sorting
// ---------------------------------------------------------------------------

function within(value: number | undefined, min?: number, max?: number): boolean {
  if (min === undefined && max === undefined) return true;
  if (value === undefined) return false;
  if (min !== undefined && value < min) return false;
  if (max !== undefined && value > max) return false;
  return true;
}

export function rowMatchesQuery(row: PriceCatalogRow, query: PriceCatalogSearchQuery): boolean {
  if (query.serviceIds && !query.serviceIds.includes(row.serviceId)) return false;
  if (query.families && !query.families.includes(row.family)) return false;
  if (!within(row.specs.vcpus, query.minVcpus, query.maxVcpus)) return false;
  if (!within(row.specs.memoryGb, query.minMemoryGb, query.maxMemoryGb)) return false;
  const gpus = row.specs.gpuCount ?? 0;
  if (query.gpu === "required" && gpus <= 0) return false;
  if (query.gpu === "none" && gpus > 0) return false;
  if (query.minGpus !== undefined && gpus < query.minGpus) return false;
  if (query.gpuModel) {
    const model = row.specs.gpuModel?.toLowerCase() ?? "";
    if (!model.includes(query.gpuModel.toLowerCase())) return false;
  }
  if (query.maxMonthlyPrice !== undefined) {
    // A row with no comparable figure cannot be shown to be under a price
    // cap, so it is excluded rather than assumed to qualify.
    if (!row.comparable || row.comparable.amount > query.maxMonthlyPrice) return false;
  }
  if (query.q) {
    const needle = query.q.toLowerCase();
    const hay = [row.sku, row.name, row.series ?? "", row.specs.gpuModel ?? "", row.pluginName]
      .join(" ")
      .toLowerCase();
    if (!needle.split(/\s+/).every((part) => hay.includes(part))) return false;
  }
  return true;
}

function sortValue(row: PriceCatalogRow, sort: PriceCatalogSort): number | string | null {
  switch (sort) {
    case "price":
      return row.comparable?.amount ?? null;
    case "vcpus":
      return row.specs.vcpus ?? null;
    case "memory":
      return row.specs.memoryGb ?? null;
    case "gpus":
      return row.specs.gpuCount ?? null;
    case "name":
      return `${row.pluginName} ${row.name}`.toLowerCase();
  }
}

/**
 * Sort rows. Missing values sort last in either direction: an unpriced or
 * unspecified row is never "the cheapest" or "the largest". Ties fall back to
 * price, then name, so the order is stable across requests.
 */
export function sortCatalogRows(
  rows: PriceCatalogRow[],
  sort: PriceCatalogSort = "price",
  order: "asc" | "desc" = "asc",
): PriceCatalogRow[] {
  const dir = order === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = sortValue(a, sort);
    const bv = sortValue(b, sort);
    if (av === null && bv !== null) return 1;
    if (bv === null && av !== null) return -1;
    if (av !== null && bv !== null && av !== bv) return (av < bv ? -1 : 1) * dir;
    const ap = a.comparable?.amount ?? Number.POSITIVE_INFINITY;
    const bp = b.comparable?.amount ?? Number.POSITIVE_INFINITY;
    if (ap !== bp) return ap < bp ? -1 : 1;
    return `${a.pluginId}:${a.sku}` < `${b.pluginId}:${b.sku}` ? -1 : 1;
  });
}

/** Distinct currencies and whether sorting crossed them without a common figure. */
export function summarizeCurrencies(rows: PriceCatalogRow[]): {
  currencies: string[];
  mixedCurrencies: boolean;
} {
  const native = new Set<string>();
  const comparable = new Set<string>();
  let missing = false;
  for (const row of rows) {
    native.add(row.price.currency);
    if (row.comparable) comparable.add(row.comparable.currency);
    else if (row.monthlyAmount !== null) missing = true;
  }
  return {
    currencies: [...native].sort(),
    mixedCurrencies: comparable.size > 1 || (missing && native.size > 1),
  };
}

// ---------------------------------------------------------------------------
// Equivalent instances
// ---------------------------------------------------------------------------

export function compareTargetFromSpecs(specs: PriceCatalogSpecs): PriceCatalogCompareTarget {
  return {
    vcpus: specs.vcpus ?? null,
    memoryGb: specs.memoryGb ?? null,
    gpuCount: specs.gpuCount && specs.gpuCount > 0 ? specs.gpuCount : null,
    gpuModel: specs.gpuModel ?? null,
  };
}

/**
 * Does a row meet every stated spec? "Meet" is at-least on each axis: the
 * question is what the cheapest machine that can run the workload costs, so a
 * 4 vCPU / 16 GB box answers a 4 / 15 request and a 2 / 32 one does not.
 * A row that does not publish a stated axis cannot be shown to meet it.
 */
export function rowMeetsTarget(row: PriceCatalogRow, target: PriceCatalogCompareTarget): boolean {
  if (target.vcpus !== null && (row.specs.vcpus === undefined || row.specs.vcpus < target.vcpus))
    return false;
  if (
    target.memoryGb !== null &&
    (row.specs.memoryGb === undefined || row.specs.memoryGb < target.memoryGb - 0.01)
  )
    return false;
  const gpus = row.specs.gpuCount ?? 0;
  if (target.gpuCount !== null && gpus < target.gpuCount) return false;
  if (target.gpuCount === null && !target.gpuModel && gpus > 0) return false;
  if (target.gpuModel) {
    const model = row.specs.gpuModel?.toLowerCase() ?? "";
    if (!model.includes(target.gpuModel.toLowerCase())) return false;
  }
  return true;
}

/**
 * The cheapest rows meeting the target, cheapest first, with ties broken by
 * the smaller machine (less overshoot is the closer equivalent).
 */
export function rankEquivalents(
  rows: PriceCatalogRow[],
  target: PriceCatalogCompareTarget,
): PriceCatalogRow[] {
  return rows
    .filter((row) => row.comparable !== null && rowMeetsTarget(row, target))
    .sort((a, b) => {
      const d = a.comparable!.amount - b.comparable!.amount;
      if (Math.abs(d) > 1e-9) return d;
      const av = (a.specs.vcpus ?? 0) + (a.specs.memoryGb ?? 0) / 4;
      const bv = (b.specs.vcpus ?? 0) + (b.specs.memoryGb ?? 0) / 4;
      return av - bv;
    });
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * A rate for display. Keeps enough precision for small hourly rates ($0.0059)
 * that `formatMoney`'s whole-dollar rounding would flatten.
 */
export function formatCatalogAmount(amount: number, currency: string): string {
  const digits = amount === 0 ? 2 : amount < 0.1 ? 4 : amount < 10 ? 3 : 2;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: Math.min(2, digits),
      maximumFractionDigits: digits,
    }).format(amount);
  } catch {
    return `${amount.toFixed(digits)} ${currency}`;
  }
}

export function formatCatalogMonthly(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function formatCatalogUnit(unit: PriceCatalogPrice["unit"]): string {
  return unit === "hour" ? "/hr" : unit === "month" ? "/mo" : "/GB-mo";
}

/** `4 vCPU · 16 GB · 1× NVIDIA L4`: specs in one line, absent axes omitted. */
export function formatCatalogSpecs(specs: PriceCatalogSpecs): string {
  const parts: string[] = [];
  if (specs.vcpus !== undefined) parts.push(`${specs.vcpus} vCPU`);
  if (specs.memoryGb !== undefined) parts.push(`${formatGb(specs.memoryGb)} GB`);
  if (specs.gpuCount) parts.push(`${specs.gpuCount}× ${specs.gpuModel ?? "GPU"}`.trim());
  if (specs.storageGb !== undefined) parts.push(`${formatGb(specs.storageGb)} GB disk`);
  return parts.join(" · ");
}

function formatGb(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(value < 10 ? 2 : 1);
}

/**
 * A search or compare query as a URL query string (`?a=1&b=x,y`): arrays
 * comma-joined, absent values dropped, `reference` flattened to
 * `referencePluginId` / `referenceSku`. The inverse of the normalizers above,
 * shared by every host that calls the routes.
 */
export function priceCatalogQueryString(
  query: PriceCatalogSearchQuery | PriceCatalogCompareQuery,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length > 0) params.set(key, value.join(","));
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        params.set(`${key}${k.charAt(0).toUpperCase()}${k.slice(1)}`, String(v));
      }
    } else {
      params.set(key, String(value));
    }
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** `Reserved 1yr (No Upfront)`. */
export function formatCatalogRateType(
  price: Pick<PriceCatalogPrice, "rateType" | "term" | "paymentOption">,
): string {
  const base = PRICE_RATE_TYPE_LABELS[price.rateType];
  const term = price.term ? ` ${price.term}` : "";
  const payment = price.paymentOption ? ` (${price.paymentOption})` : "";
  return `${base}${term}${payment}`;
}
