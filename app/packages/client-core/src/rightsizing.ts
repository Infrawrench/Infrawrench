/**
 * Right-sizing ("Oversized") — the pure half of the savings finder's second
 * question: not "is this resource wasted entirely" (orphans) but "is it
 * bigger than what it does".
 *
 * Plugins opt types in with a `rightsizing` declaration
 * (`RightsizingDeclaration` in `@infrawrench/plugin-base`): which field holds
 * the size id, which stored metric series measure CPU/memory utilisation, and
 * how to read them. The host supplies the candidate size catalog (the create
 * form's own size-picker options) and 14-day utilisation percentiles from the
 * metrics warehouse; this module turns those into a recommendation — or,
 * mostly, into nothing, which is the correct answer for a well-sized fleet.
 *
 * Everything here is pure and unit-tested: quantiles + catalog in,
 * recommendation out. The plugin-base import is type-only on purpose so this
 * module keeps zero runtime dependency on plugin-base (the mobile bundle
 * imports this file's wire types through the client-core barrel).
 */
import type { RightsizingDeclaration } from "@infrawrench/plugin-base";

import type { CloudFetch } from "./fetch";

export type {
  RightsizingDeclaration,
  RightsizingCpuMetric,
  RightsizingMemoryMetric,
} from "@infrawrench/plugin-base";

/**
 * Tunable knobs for the oversized classification. Kept in code (not org
 * settings) deliberately: these are engineering judgment calls, and a wrong
 * org-level knob silently hides money.
 */
export interface RightsizingThresholds {
  /** A resource is only oversized when p95 CPU is strictly below this (%). */
  cpuP95Max: number;
  /**
   * …and, when memory is measured, p95 memory utilisation is strictly below
   * this (%).
   */
  memoryP95Max: number;
  /**
   * A candidate size qualifies when the projected p95 utilisation on it stays
   * at or under this fraction of capacity — the recommendation keeps real
   * headroom rather than sizing to the observed peak.
   */
  headroom: number;
  /**
   * Minimum minutes of stored CPU samples inside the window before any
   * recommendation is made. 1m-rollup rows arrive roughly one per minute
   * while a resource is pinned and running, so this is ≈ days × 1440.
   */
  minCoverageMinutes: number;
  /**
   * When the provider stores no memory series, a candidate must still keep at
   * least this fraction of the current size's RAM — an unmeasured halving is
   * the most a recommendation will ever suggest.
   */
  memoryFloorWhenUnmeasured: number;
}

/** 14 trailing days — far enough back to include weekly load patterns. */
export const RIGHTSIZING_WINDOW_DAYS = 14;

export const DEFAULT_RIGHTSIZING_THRESHOLDS: RightsizingThresholds = {
  cpuP95Max: 20,
  memoryP95Max: 40,
  headroom: 0.7,
  minCoverageMinutes: 3 * 24 * 60,
  memoryFloorWhenUnmeasured: 0.5,
};

/** One entry of a type's size catalog, as the create form's size-picker declares it. */
export interface RightsizingSizeOption {
  id: string;
  label: string;
  vcpus: number;
  memoryMb: number;
  diskGb?: number | undefined;
  priceMonthly?: number | undefined;
  /** Region tags; when present, a candidate must carry the resource's region. */
  availableFor?: string[] | undefined;
}

/** Per-series quantiles over the window, as read from the metrics warehouse. */
export interface SeriesQuantiles {
  label: string;
  /** 5th percentile of the per-minute averages. */
  q05: number;
  /** 95th percentile of the per-minute averages. */
  q95: number;
  max: number;
  /** Number of per-minute samples backing the quantiles. */
  samples: number;
}

/** What the declared metric series say about the current size's utilisation. */
export interface ResolvedUtilisation {
  /** p95 CPU utilisation as a percent of the current size, or null when unstored. */
  cpuP95: number | null;
  /** Per-minute samples behind `cpuP95` (coverage gate). */
  cpuSamples: number;
  /** p95 memory utilisation as a percent of the current size, when measured. */
  memoryP95: number | null;
  /** False when the provider stores no usable memory series for this resource. */
  memoryMeasured: boolean;
}

/**
 * Read the declared CPU/memory series out of a resource's stored quantiles.
 *
 * `currentMemoryMb` is the current size's total RAM — required to turn
 * byte-denominated series into a percent; byte series without it resolve to
 * "unmeasured" rather than a guess. For `available-bytes` series the p95 of
 * *used* memory is `total − q05(available)`: the busiest moments are the ones
 * with the least available, so the low quantile of the series is the high
 * quantile of usage.
 */
export function resolveUtilisation(
  declaration: Pick<RightsizingDeclaration, "cpuMetric" | "memoryMetric">,
  quantiles: readonly SeriesQuantiles[],
  currentMemoryMb: number | null,
): ResolvedUtilisation {
  const cpuSeries = quantiles.find((q) => q.label === declaration.cpuMetric.seriesLabel);
  const cpuScale = declaration.cpuMetric.scale === "fraction" ? 100 : 1;
  const cpuP95 = cpuSeries ? clampPercent(cpuSeries.q95 * cpuScale) : null;

  let memoryP95: number | null = null;
  const memDecl = declaration.memoryMetric;
  if (memDecl) {
    const series = quantiles.find((q) => q.label === memDecl.seriesLabel);
    if (series) {
      if (memDecl.interpretation === "percent") {
        memoryP95 = clampPercent(series.q95);
      } else if (currentMemoryMb !== null && currentMemoryMb > 0) {
        const capacityBytes = currentMemoryMb * 1024 * 1024;
        const usedP95Bytes =
          memDecl.interpretation === "used-bytes"
            ? series.q95
            : Math.max(0, capacityBytes - series.q05);
        memoryP95 = clampPercent((usedP95Bytes / capacityBytes) * 100);
      }
    }
  }

  return {
    cpuP95,
    cpuSamples: cpuSeries?.samples ?? 0,
    memoryP95,
    memoryMeasured: memoryP95 !== null,
  };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export interface SizeRecommendationInput {
  /** The resource's stored size-field value. */
  currentSizeId: string;
  /** The type's full size catalog. */
  sizes: readonly RightsizingSizeOption[];
  utilisation: ResolvedUtilisation;
  /** Resource's region value, matched against `availableFor` when both exist. */
  region?: string | null | undefined;
  /**
   * The resource's *actual* disk size in GB (from `diskFieldKey`), when the
   * provider bundles the disk with the size. Hetzner and DigitalOcean refuse
   * any resize to a size whose included disk is smaller than the disk the
   * machine already has, so candidates below it are dropped. Falls back to
   * the current size's `diskGb` when unknown — conservative: a disk never
   * shrinks, so the current type's included disk is an upper bound.
   */
  currentDiskGb?: number | null | undefined;
  /** `RightsizingDeclaration.sizeFamilyPattern`, already validated by plugin-base. */
  sizeFamilyPattern?: string | undefined;
  thresholds?: RightsizingThresholds | undefined;
}

export interface SizeRecommendation {
  current: RightsizingSizeOption;
  recommended: RightsizingSizeOption;
  /** p95 CPU as a percent of the *recommended* size, for the confirm dialog. */
  projectedCpuP95: number;
  /** p95 memory as a percent of the recommended size, when measured. */
  projectedMemoryP95: number | null;
  /** current − recommended monthly price; null when either price is unknown. */
  monthlySaving: number | null;
}

/**
 * The oversized decision: is the resource's p95 utilisation under the
 * thresholds, and if so, which is the cheapest catalog size that still clears
 * the headroom rule. Returns null in every "leave it alone" case — unknown
 * current size, thin metric coverage, healthy utilisation, or no candidate
 * that fits.
 */
export function computeSizeRecommendation(
  input: SizeRecommendationInput,
): SizeRecommendation | null {
  const thresholds = input.thresholds ?? DEFAULT_RIGHTSIZING_THRESHOLDS;
  const { cpuP95, cpuSamples, memoryP95, memoryMeasured } = input.utilisation;

  const current = input.sizes.find((s) => s.id === input.currentSizeId);
  // An unknown current size means no capacity baseline to project from.
  if (!current || current.vcpus <= 0 || current.memoryMb <= 0) return null;

  if (cpuP95 === null || cpuSamples < thresholds.minCoverageMinutes) return null;
  if (cpuP95 >= thresholds.cpuP95Max) return null;
  if (memoryMeasured && memoryP95 !== null && memoryP95 >= thresholds.memoryP95Max) return null;

  const family = matchFamily(input.sizeFamilyPattern, current.id);
  const headroomPct = thresholds.headroom * 100;
  const usedMemoryMb =
    memoryMeasured && memoryP95 !== null ? (memoryP95 / 100) * current.memoryMb : null;
  const minDiskGb = input.currentDiskGb ?? current.diskGb;

  let best: RightsizingSizeOption | null = null;
  for (const candidate of input.sizes) {
    if (candidate.id === current.id) continue;
    if (candidate.vcpus <= 0 || candidate.memoryMb <= 0) continue;
    // A "downsize" must not grow either axis, and must shrink at least one.
    if (candidate.vcpus > current.vcpus || candidate.memoryMb > current.memoryMb) continue;
    if (candidate.vcpus === current.vcpus && candidate.memoryMb === current.memoryMb) continue;
    // Price the delta or don't recommend: a quote-less row can't be ranked.
    if (candidate.priceMonthly === undefined || candidate.priceMonthly <= 0) continue;
    if (current.priceMonthly !== undefined && candidate.priceMonthly >= current.priceMonthly)
      continue;
    // Provider-rejectable combinations: wrong family/architecture, region
    // where the size doesn't exist, or a smaller included disk than the data
    // currently on it.
    if (family !== null && matchFamily(input.sizeFamilyPattern, candidate.id) !== family) continue;
    if (
      input.region &&
      candidate.availableFor !== undefined &&
      !candidate.availableFor.includes(input.region)
    )
      continue;
    if (candidate.diskGb !== undefined && minDiskGb != null && candidate.diskGb < minDiskGb)
      continue;

    // Headroom: the observed p95 must fit comfortably on the candidate.
    const projectedCpu = (cpuP95 * current.vcpus) / candidate.vcpus;
    if (projectedCpu > headroomPct) continue;
    if (usedMemoryMb !== null) {
      if (usedMemoryMb > thresholds.headroom * candidate.memoryMb) continue;
    } else if (candidate.memoryMb < thresholds.memoryFloorWhenUnmeasured * current.memoryMb) {
      // Memory unmeasured: never suggest cutting RAM below the floor.
      continue;
    }

    if (
      best === null ||
      candidate.priceMonthly < best.priceMonthly! ||
      (candidate.priceMonthly === best.priceMonthly &&
        (candidate.vcpus < best.vcpus ||
          (candidate.vcpus === best.vcpus && candidate.memoryMb < best.memoryMb)))
    ) {
      best = candidate;
    }
  }

  if (!best) return null;

  const projectedCpuP95 = round2((cpuP95 * current.vcpus) / best.vcpus);
  const projectedMemoryP95 =
    usedMemoryMb !== null ? round2(Math.min(100, (usedMemoryMb / best.memoryMb) * 100)) : null;
  const monthlySaving =
    current.priceMonthly !== undefined && best.priceMonthly !== undefined
      ? round2(current.priceMonthly - best.priceMonthly)
      : null;

  return { current, recommended: best, projectedCpuP95, projectedMemoryP95, monthlySaving };
}

/** Capture-group tuple of `pattern` over `sizeId`, or null when no pattern / no match. */
function matchFamily(pattern: string | undefined, sizeId: string): string | null {
  if (!pattern) return null;
  let match: RegExpExecArray | null;
  try {
    match = new RegExp(pattern).exec(sizeId);
  } catch {
    return null;
  }
  if (!match) return null;
  return JSON.stringify(match.slice(1));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Wire types — `GET /api/org/:orgId/rightsizing`, shared by web, desktop,
// mobile and the CLI so a server-side change breaks builds instead of output.
// ---------------------------------------------------------------------------

/** The slice of a size option the response quotes. */
export interface OversizedSizeSummary {
  id: string;
  label: string;
  vcpus: number;
  memoryMb: number;
  /** Monthly price in `OversizedResource.currency`; null when unpriced. */
  priceMonthly: number | null;
}

export interface OversizedResource {
  /** Infrawrench resource id. */
  id: string;
  pluginId: string;
  resourceTypeId: string;
  /** Display name of the resource type, e.g. "Server". */
  resourceTypeName: string;
  displayName: string;
  externalId: string | null;
  /** Field to submit through the resource-update path to apply the resize. */
  sizeFieldKey: string;
  region: string | null;
  currentSize: OversizedSizeSummary;
  recommendedSize: OversizedSizeSummary;
  /** p95 CPU utilisation over the window, percent of the current size. */
  cpuP95: number;
  /** p95 memory utilisation, percent of the current size; null when unmeasured. */
  memoryP95: number | null;
  /** False when the provider stores no memory series — the UI must say so. */
  memoryMeasured: boolean;
  /** Projected p95 CPU on the recommended size, for the confirm dialog. */
  projectedCpuP95: number;
  /** ISO 4217 code the prices are quoted in. */
  currency: string;
  /** current − recommended monthly price; null when either side is unpriced. */
  monthlySaving: number | null;
  /** Plugin-authored caveat for the confirm dialog (e.g. "power off first"). */
  resizeNote: string | null;
  lastSyncedAt: string | null;
}

export interface OversizedAccountGroup {
  accountId: string;
  accountName: string;
  pluginId: string;
  pluginName: string;
  resources: OversizedResource[];
}

export interface RightsizingListResponse {
  /** Groups sorted by account name; empty when nothing looks oversized. */
  accounts: OversizedAccountGroup[];
  totalCount: number;
  /** Days of stored metrics the percentiles cover. */
  windowDays: number;
  generatedAt: string;
}

/** Bearer reader used by the mobile app (and anything else on `CloudFetch`). */
export async function fetchRightsizing(
  api: CloudFetch,
  orgId: string,
): Promise<RightsizingListResponse> {
  const response = await api.org<RightsizingListResponse | null>(orgId, "/rightsizing");
  return (
    response ?? {
      accounts: [],
      totalCount: 0,
      windowDays: RIGHTSIZING_WINDOW_DAYS,
      generatedAt: "",
    }
  );
}
