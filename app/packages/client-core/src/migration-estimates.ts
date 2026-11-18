/**
 * Migration estimates: "what would this service cost on provider X?".
 *
 * The wire contract and the pure parts of the estimate every surface shares:
 * the server's routes and MCP tool, the CLI's text output, and the web and
 * desktop panel. The server gathers the inputs (resources, billed spend,
 * price catalogs, size pickers, plugin estimates); everything here is a
 * function of its arguments.
 *
 * The rules that carry through:
 *
 * - **A resource is matched by category, sized by its flagged fields.** Each
 *   plugin says what its types are (`equivalence`) and which fields carry
 *   the size (`sizing`); nothing here knows a provider's field names.
 * - **At least, never less.** A target size qualifies when it meets or
 *   exceeds the source's vCPUs, memory and GPUs; the cheapest qualifying one
 *   is the default, and the user can override any row.
 * - **Unknown is not zero.** A cost nobody can price is `null` and counted as
 *   unknown in the totals, never added as `0`.
 */
import type { EquivalenceCategory } from "@infrawrench/plugin-base";
import type { PriceCatalogArea } from "./price-catalog";
import { PROVIDER_REGION_ZONES, normalizeCarbonRegion } from "./carbon-factors";
import type { CostScenarioModelInput } from "./cost-scenarios";

export type { EquivalenceCategory };

// ---------------------------------------------------------------------------
// Saved estimates
// ---------------------------------------------------------------------------

/** What an estimate prices: a service's members, or a hand-picked set. */
export type MigrationEstimateSource =
  { kind: "service"; serviceId: string } | { kind: "resources"; resourceIds: string[] };

/** A user's choice for one row, replacing the automatic match. */
export interface MigrationRowOverride {
  /** Target resource type, when the category has more than one. */
  resourceTypeId?: string | undefined;
  /** Target size id (catalog SKU or size-picker id). */
  sizeId?: string | undefined;
}

export interface MigrationEstimateInput {
  name: string;
  source: MigrationEstimateSource;
  targetPluginId: string;
  /** Null: the region nearest the source resources, per row's area. */
  targetRegion: string | null;
  /** Keyed by the source resource's id. */
  overrides: Record<string, MigrationRowOverride>;
}

/** A saved estimate. Only the inputs are stored; the figures are computed on read. */
export interface MigrationEstimate extends MigrationEstimateInput {
  id: string;
  /** The service's name for a service source, null otherwise. */
  sourceName: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const MIGRATION_ESTIMATE_LIMITS = {
  maxNameLength: 120,
  maxResources: 500,
  maxOverrides: 500,
  maxEstimatesPerOrg: 200,
} as const;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface MigrationMoney {
  amount: number;
  currency: string;
}

/**
 * Where a figure came from.
 *
 * - `billed`: the resource's own spend in collected cost data over the last
 *   30 days, scaled to a 730-hour month.
 * - `estimate`: the plugin's `estimateCost` for that configuration.
 * - `list-price`: the matched size's published list price, times the count.
 */
export type MigrationCostBasis = "billed" | "estimate" | "list-price";

export interface MigrationCost extends MigrationMoney {
  basis: MigrationCostBasis;
  /** Only part of the resource could be priced; the true figure is higher. */
  partial: boolean;
}

export interface MigrationSpecs {
  vcpus: number | null;
  memoryGb: number | null;
  gpuCount: number | null;
  gpuModel: string | null;
  diskGb: number | null;
  /** Units the resource runs (nodes, replicas). */
  count: number;
}

/** One size the target offers for a row: what the per-row picker lists. */
export interface MigrationSizeOption {
  id: string;
  label: string;
  vcpus: number | null;
  memoryGb: number | null;
  gpuCount: number | null;
  gpuModel: string | null;
  /** Monthly price of one unit, or null when the source publishes none. */
  monthly: MigrationMoney | null;
  /** Meets or exceeds every known axis of the source. */
  meetsSpec: boolean;
}

/**
 * Why a matched row has no target figure.
 *
 * - `no-account`: the target's prices or sizes need one of the org's
 *   accounts on that provider, and there is none.
 * - `source-size-unknown`: the source's vCPUs and memory could not be read,
 *   so no size can be shown to meet them.
 * - `no-size-match`: no size the target offers meets the source.
 * - `no-price`: a size was matched but nothing publishes its price.
 * - `catalog-unavailable`: the target's price list is still loading or failed.
 */
export type MigrationTargetNote =
  "no-account" | "source-size-unknown" | "no-size-match" | "no-price" | "catalog-unavailable";

export interface MigrationTargetType {
  id: string;
  name: string;
}

export interface MigrationRowTarget {
  resourceTypeId: string;
  resourceTypeName: string;
  sizeId: string | null;
  sizeLabel: string | null;
  vcpus: number | null;
  memoryGb: number | null;
  gpuCount: number | null;
  region: string | null;
  regionLabel: string | null;
  cost: MigrationCost | null;
  /** The size or type came from the user's override, not the automatic match. */
  overridden: boolean;
}

export interface MigrationRow {
  resourceId: string;
  displayName: string;
  pluginId: string;
  pluginName: string;
  resourceTypeId: string;
  resourceTypeName: string;
  accountId: string;
  category: EquivalenceCategory;
  sourceRegion: string | null;
  sourceArea: PriceCatalogArea | null;
  /** The source's size id, when its type stores one. */
  instanceType: string | null;
  specs: MigrationSpecs;
  current: MigrationCost | null;
  target: MigrationRowTarget;
  note: MigrationTargetNote | null;
  /** Sizes for the picker, cheapest first, qualifying ones first. */
  candidates: MigrationSizeOption[];
  /** The target's types in this category, for the type override. */
  targetTypes: MigrationTargetType[];
}

/**
 * A resource with no counterpart on the target.
 *
 * - `no-category`: its type declares no cross-provider category.
 * - `no-target-type`: the target provider has no type in its category.
 */
export type MigrationUnmatchedReason = "no-category" | "no-target-type";

export interface MigrationUnmatchedRow {
  resourceId: string;
  displayName: string;
  pluginId: string;
  pluginName: string;
  resourceTypeId: string;
  resourceTypeName: string;
  category: EquivalenceCategory | null;
  reason: MigrationUnmatchedReason;
  current: MigrationCost | null;
}

export interface MigrationComparable {
  currency: string;
  /** Every priced current figure, converted. */
  current: number;
  /** Every priced target figure, converted. */
  target: number;
  /**
   * Target minus current over the rows priced on **both** sides: the honest
   * delta, since a row priced on one side only would read as all saving or
   * all cost. Negative saves money.
   */
  pairedDelta: number;
  pairedRows: number;
}

export interface MigrationTotals {
  /** Per currency, as priced. */
  current: MigrationMoney[];
  target: MigrationMoney[];
  /** Matched rows with no current / no target figure. */
  currentUnknown: number;
  targetUnknown: number;
  /** Unmatched resources' current spend, kept out of `current`. */
  unmatchedCurrent: MigrationMoney[];
  /** Everything in one currency, when every figure converts; null otherwise. */
  comparable: MigrationComparable | null;
}

/**
 * - `user`: the estimate names the region.
 * - `nearest`: the target's first region in the area most source resources
 *   are in.
 * - `default`: the source area is unknown, so the target's default region.
 * - `none`: the target lists no regions the host can choose from.
 */
export type MigrationRegionChoice = "user" | "nearest" | "default" | "none";

export interface MigrationRegionNote {
  region: string | null;
  regionLabel: string | null;
  area: PriceCatalogArea | null;
  sourceAreas: PriceCatalogArea[];
  choice: MigrationRegionChoice;
  /**
   * Some source resources are in another area than the target region, so
   * latency to their users changes. Null when an area is unknown.
   */
  crossesArea: boolean | null;
}

export interface MigrationEstimateResult {
  estimateId: string | null;
  name: string;
  source: { kind: MigrationEstimateSource["kind"]; label: string; resourceCount: number };
  target: { pluginId: string; pluginName: string };
  region: MigrationRegionNote;
  rows: MigrationRow[];
  unmatched: MigrationUnmatchedRow[];
  totals: MigrationTotals;
  /** The org's display currency, when one is configured. */
  displayCurrency: string | null;
  /** The target plugin can write Terraform for at least one matched row. */
  terraform: boolean;
  /** Source resources past `maxResources`, left out. */
  truncated: boolean;
  generatedAt: string;
}

export interface MigrationTargetRegion {
  id: string;
  label: string;
  area: PriceCatalogArea | null;
}

/** A provider an estimate can target. */
export interface MigrationTargetProvider {
  pluginId: string;
  pluginName: string;
  categories: EquivalenceCategory[];
  regions: MigrationTargetRegion[];
  /** The provider publishes a machine price catalog. */
  priceCatalog: boolean;
  /** Pricing needs an account on the provider (credentialed catalog or size picker). */
  needsAccount: boolean;
  hasAccount: boolean;
  terraform: boolean;
}

export interface MigrationTerraformResult {
  hcl: string;
  exported: Array<{ resourceId: string; address: string }>;
  unsupported: Array<{ resourceId: string; displayName: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Labels (English; the UI translates its own)
// ---------------------------------------------------------------------------

export const MIGRATION_CATEGORY_LABELS: Record<EquivalenceCategory, string> = {
  vm: "Virtual machine",
  "kubernetes-cluster": "Kubernetes cluster",
  "kubernetes-node-pool": "Kubernetes node pool",
  "managed-postgres": "Managed PostgreSQL",
  "managed-mysql": "Managed MySQL",
  "managed-redis": "Managed Redis",
  "managed-mongodb": "Managed MongoDB",
  "object-storage": "Object storage",
  "block-volume": "Block volume",
  "file-storage": "File storage",
  "load-balancer": "Load balancer",
  "container-app": "Container app",
  "serverless-function": "Serverless function",
  "container-registry": "Container registry",
  "static-ip": "Static IP",
  "dns-zone": "DNS zone",
};

export const MIGRATION_NOTE_LABELS: Record<MigrationTargetNote, string> = {
  "no-account": "Needs an account on the target provider",
  "source-size-unknown": "Source size unknown",
  "no-size-match": "No size meets the source",
  "no-price": "No published price",
  "catalog-unavailable": "Price list unavailable",
};

export const MIGRATION_UNMATCHED_LABELS: Record<MigrationUnmatchedReason, string> = {
  "no-category": "No cross-provider equivalent",
  "no-target-type": "The target has no equivalent type",
};

export const MIGRATION_BASIS_LABELS: Record<MigrationCostBasis, string> = {
  billed: "billed",
  estimate: "estimate",
  "list-price": "list price",
};

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

/** Area of each country (or `US-<NERC>` zone) the carbon tables place a region in. */
const COUNTRY_AREAS: Record<string, PriceCatalogArea> = {
  AE: "middle-east",
  AR: "south-america",
  AU: "oceania",
  BR: "south-america",
  CA: "north-america",
  CL: "south-america",
  CO: "south-america",
  DE: "europe",
  ES: "europe",
  FI: "europe",
  FR: "europe",
  GB: "europe",
  HK: "asia-pacific",
  IL: "middle-east",
  IN: "asia-pacific",
  IT: "europe",
  JP: "asia-pacific",
  MX: "north-america",
  NL: "europe",
  NZ: "oceania",
  PL: "europe",
  QA: "middle-east",
  RO: "europe",
  SE: "europe",
  SG: "asia-pacific",
  ZA: "africa",
};

/**
 * The area a provider region is in: from the provider's price catalog regions
 * when it declares them, else from where the carbon tables place the site.
 * Null when neither knows the region, which the estimate reports rather than
 * guesses.
 */
export function migrationRegionArea(
  pluginId: string,
  region: string | null | undefined,
  catalogRegions: ReadonlyArray<{ id: string; area: PriceCatalogArea }> = [],
): PriceCatalogArea | null {
  if (!region) return null;
  const lower = region.trim().toLowerCase();
  const declared = catalogRegions.find((r) => r.id.toLowerCase() === lower);
  if (declared) return declared.area;
  const zones = PROVIDER_REGION_ZONES[pluginId];
  if (zones) {
    const zone = zones[normalizeCarbonRegion(pluginId, region)];
    if (zone) return zone.startsWith("US-") ? "north-america" : (COUNTRY_AREAS[zone] ?? null);
  }
  // A zone of a declared region (`us-east-1a`, `fsn1-dc14`, `fr-par-1`).
  const prefix = catalogRegions.find((r) => lower.startsWith(r.id.toLowerCase()));
  return prefix?.area ?? null;
}

/**
 * The regions a target can be priced in, with their areas: the catalog's
 * declared regions when the provider has a catalog, else the sites the carbon
 * tables place.
 */
export function migrationTargetRegions(
  pluginId: string,
  catalogRegions: ReadonlyArray<{ id: string; label: string; area: PriceCatalogArea }> | null,
): MigrationTargetRegion[] {
  if (catalogRegions && catalogRegions.length > 0) {
    return catalogRegions.map((r) => ({ id: r.id, label: r.label, area: r.area }));
  }
  const zones = PROVIDER_REGION_ZONES[pluginId];
  if (!zones) return [];
  return Object.keys(zones).map((id) => ({
    id,
    label: id,
    area: migrationRegionArea(pluginId, id),
  }));
}

/** The most common area among the sources, ties to the first seen. */
export function dominantArea(
  areas: ReadonlyArray<PriceCatalogArea | null>,
): PriceCatalogArea | null {
  const counts = new Map<PriceCatalogArea, number>();
  for (const area of areas) if (area) counts.set(area, (counts.get(area) ?? 0) + 1);
  let best: PriceCatalogArea | null = null;
  let bestCount = 0;
  for (const [area, count] of counts) {
    if (count > bestCount) {
      best = area;
      bestCount = count;
    }
  }
  return best;
}

/** Pick the target region: the user's, else the first in the sources' area, else the first. */
export function chooseMigrationRegion(
  regions: readonly MigrationTargetRegion[],
  sourceAreas: ReadonlyArray<PriceCatalogArea | null>,
  explicit: string | null,
): { region: MigrationTargetRegion | null; choice: MigrationRegionChoice } {
  if (explicit) {
    const named = regions.find((r) => r.id === explicit);
    return { region: named ?? { id: explicit, label: explicit, area: null }, choice: "user" };
  }
  if (regions.length === 0) return { region: null, choice: "none" };
  const area = dominantArea(sourceAreas);
  if (area) {
    const nearest = regions.find((r) => r.area === area);
    if (nearest) return { region: nearest, choice: "nearest" };
  }
  return { region: regions[0]!, choice: "default" };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** The axes a target size must meet. Null = the source does not say. */
export interface MigrationSpecTarget {
  vcpus: number | null;
  memoryGb: number | null;
  gpuCount: number | null;
}

/** Whether a size meets every known axis (memory within 1% for rounding). */
export function sizeMeetsSpec(
  size: Pick<MigrationSizeOption, "vcpus" | "memoryGb" | "gpuCount">,
  spec: MigrationSpecTarget,
): boolean {
  if (spec.vcpus !== null && (size.vcpus === null || size.vcpus < spec.vcpus)) return false;
  if (spec.memoryGb !== null && (size.memoryGb === null || size.memoryGb < spec.memoryGb * 0.99))
    return false;
  const gpus = size.gpuCount ?? 0;
  if (spec.gpuCount !== null && spec.gpuCount > 0 && gpus < spec.gpuCount) return false;
  // A CPU workload is not matched to a GPU machine because it happens to be cheapest.
  if ((spec.gpuCount === null || spec.gpuCount === 0) && gpus > 0) return false;
  return true;
}

/** The source states at least one axis a size can be measured against. */
export function specIsKnown(spec: MigrationSpecTarget): boolean {
  return spec.vcpus !== null || spec.memoryGb !== null || (spec.gpuCount ?? 0) > 0;
}

/**
 * Rank sizes for the picker: qualifying sizes first, each group cheapest
 * first (unpriced last), ties to the smaller machine. `meetsSpec` is set on
 * every option.
 */
export function rankMigrationSizes(
  sizes: readonly Omit<MigrationSizeOption, "meetsSpec">[],
  spec: MigrationSpecTarget,
  convert: (money: MigrationMoney) => number | null = (m) => m.amount,
): MigrationSizeOption[] {
  const known = specIsKnown(spec);
  const options = sizes.map((s) => ({ ...s, meetsSpec: known && sizeMeetsSpec(s, spec) }));
  const price = (o: MigrationSizeOption) => (o.monthly ? convert(o.monthly) : null);
  return options.sort((a, b) => {
    if (a.meetsSpec !== b.meetsSpec) return a.meetsSpec ? -1 : 1;
    const pa = price(a);
    const pb = price(b);
    if (pa === null && pb !== null) return 1;
    if (pb === null && pa !== null) return -1;
    if (pa !== null && pb !== null && Math.abs(pa - pb) > 1e-9) return pa - pb;
    const va = (a.vcpus ?? 0) + (a.memoryGb ?? 0) / 4;
    const vb = (b.vcpus ?? 0) + (b.memoryGb ?? 0) / 4;
    return va - vb;
  });
}

/** The automatic match: the cheapest priced qualifying size, else the first qualifying one. */
export function pickMigrationSize(
  ranked: readonly MigrationSizeOption[],
): MigrationSizeOption | null {
  const qualifying = ranked.filter((o) => o.meetsSpec);
  return qualifying.find((o) => o.monthly !== null) ?? qualifying[0] ?? null;
}

/** How many candidates a row carries for its picker. */
export const MIGRATION_MAX_CANDIDATES = 40;

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

function addTo(list: MigrationMoney[], money: MigrationMoney): void {
  const same = list.find((m) => m.currency === money.currency);
  if (same) same.amount += money.amount;
  else list.push({ ...money });
}

function rounded(list: MigrationMoney[]): MigrationMoney[] {
  return list
    .map((m) => ({ currency: m.currency, amount: Math.round(m.amount * 100) / 100 }))
    .sort((a, b) => b.amount - a.amount);
}

/**
 * Totals for a set of rows. Per-currency sums always; a single comparable
 * currency when `convert` turns every priced figure into the same one (the
 * org's display currency, or the one currency everything is already in).
 */
export function summarizeMigrationTotals(
  rows: readonly { current: MigrationCost | null; target: { cost: MigrationCost | null } }[],
  unmatched: readonly Pick<MigrationUnmatchedRow, "current">[],
  convert: (money: MigrationMoney) => MigrationMoney | null,
): MigrationTotals {
  const current: MigrationMoney[] = [];
  const target: MigrationMoney[] = [];
  const unmatchedCurrent: MigrationMoney[] = [];
  let currentUnknown = 0;
  let targetUnknown = 0;
  let comparableCurrency: string | null = null;
  let comparableOk = true;
  let cmpCurrent = 0;
  let cmpTarget = 0;
  let pairedDelta = 0;
  let pairedRows = 0;

  const toComparable = (money: MigrationMoney): number | null => {
    const converted = convert(money);
    if (!converted) return null;
    if (comparableCurrency === null) comparableCurrency = converted.currency;
    if (converted.currency !== comparableCurrency) return null;
    return converted.amount;
  };

  for (const row of rows) {
    const cur = row.current;
    const tgt = row.target.cost;
    if (cur) addTo(current, cur);
    else currentUnknown += 1;
    if (tgt) addTo(target, tgt);
    else targetUnknown += 1;
    const c = cur ? toComparable(cur) : null;
    const t = tgt ? toComparable(tgt) : null;
    if ((cur && c === null) || (tgt && t === null)) comparableOk = false;
    if (c !== null) cmpCurrent += c;
    if (t !== null) cmpTarget += t;
    if (c !== null && t !== null) {
      pairedDelta += t - c;
      pairedRows += 1;
    }
  }
  for (const row of unmatched) if (row.current) addTo(unmatchedCurrent, row.current);

  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    current: rounded(current),
    target: rounded(target),
    currentUnknown,
    targetUnknown,
    unmatchedCurrent: rounded(unmatchedCurrent),
    comparable:
      comparableOk && comparableCurrency !== null
        ? {
            currency: comparableCurrency,
            current: round(cmpCurrent),
            target: round(cmpTarget),
            pairedDelta: round(pairedDelta),
            pairedRows,
          }
        : null,
  };
}

// ---------------------------------------------------------------------------
// Scenario model
// ---------------------------------------------------------------------------

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The scenario model a migration estimate becomes: one recurring monthly
 * amount, the paired delta, from the day the migration lands. Null when the
 * estimate has no single-currency delta to state (mixed currencies without
 * rates, or no row priced on both sides).
 */
export function migrationScenarioInput(
  result: Pick<MigrationEstimateResult, "name" | "target" | "totals">,
  opts: { name?: string | undefined; startDate: string },
): CostScenarioModelInput | null {
  const comparable = result.totals.comparable;
  if (!comparable || comparable.pairedRows === 0) return null;
  if (!ISO_DAY.test(opts.startDate)) return null;
  const name = (opts.name?.trim() || `${result.name} on ${result.target.pluginName}`).slice(0, 120);
  const amountCents = Math.round(comparable.pairedDelta * 100);
  return {
    name,
    description:
      `Migration estimate: ${comparable.pairedRows} resource(s) moved to ` +
      `${result.target.pluginName}, list prices against current spend.`,
    currency: comparable.currency,
    adjustments: [
      {
        id: "migration",
        label: `Move to ${result.target.pluginName}`.slice(0, 120),
        kind: "recurring",
        startDate: opts.startDate,
        endDate: null,
        amountCents,
        currency: comparable.currency,
        period: "monthly",
        percent: null,
        scope: [],
      },
    ],
  };
}
