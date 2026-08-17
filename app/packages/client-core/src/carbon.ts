/**
 * The carbon estimate — CO2e beside the cost, with its assumptions on screen.
 *
 * This is an **estimate**, in the same sense the cost estimates already in this
 * product are, and it is built to be honest about that in three specific ways:
 *
 * 1. **A resource we cannot place is never guessed.** No region in the table,
 *    no vCPU count, an unsupported provider — each produces an `unestimated`
 *    row with a stated reason, and contributes nothing to the total. A carbon
 *    figure computed against a guessed grid is worse than no figure, because it
 *    is a number somebody will put in a report.
 * 2. **The assumptions travel with the answer.** Utilisation, PUE and the
 *    coefficient vintage are on the response, not buried in a constant.
 * 3. **It covers compute and says so.** Storage, network and managed services
 *    are out of scope; reporting a total that silently omitted them while
 *    looking complete would be the same failure in a different place.
 *
 * The arithmetic is the Cloud Carbon Footprint operational formula:
 * `vCPUs × watts(utilisation) × hours × PUE ÷ 1000 × gridIntensity`. Embodied
 * (manufacturing) emissions are deliberately excluded — they need hardware
 * lifetimes and machine counts nobody here has.
 */
import {
  ASSUMED_CPU_UTILIZATION,
  PROVIDER_PUE,
  VCPU_WATTS,
  gridIntensityFor,
} from "./carbon-factors";

export type CarbonUnestimatedReason = "unsupported-provider" | "unknown-region" | "unknown-size";

export interface CarbonInputResource {
  resourceId: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  accountName: string | null;
  displayName: string;
  /** Provider region as synced, in whatever form the plugin reports it. */
  region: string | null;
  /** vCPUs, when the resource type declares a size the lister syncs. */
  vcpus: number | null;
}

export interface CarbonRow {
  resourceId: string;
  displayName: string;
  pluginId: string;
  accountId: string;
  accountName: string | null;
  region: string | null;
  vcpus: number;
  /** Grams CO2e per kWh used for this row — the number, not a band. */
  gridIntensity: number;
  /** Estimated kWh over the window. */
  kwh: number;
  /** Estimated kilograms CO2e over the window. */
  kgCo2e: number;
}

export interface CarbonUnestimatedRow {
  resourceId: string;
  displayName: string;
  pluginId: string;
  accountId: string;
  accountName: string | null;
  region: string | null;
  reason: CarbonUnestimatedReason;
}

export interface CarbonGroup {
  key: string;
  label: string;
  kgCo2e: number;
  kwh: number;
  resourceCount: number;
}

export interface CarbonEstimate {
  /** Days the estimate covers. */
  windowDays: number;
  totalKgCo2e: number;
  totalKwh: number;
  estimatedCount: number;
  /**
   * Resources that could not be estimated, with the reason. Counted and listed
   * rather than dropped: a total that quietly excluded a third of the estate
   * would read as a complete answer.
   */
  unestimated: CarbonUnestimatedRow[];
  byRegion: CarbonGroup[];
  byAccount: CarbonGroup[];
  rows: CarbonRow[];
  assumptions: CarbonAssumptions;
  generatedAt: string;
}

export interface CarbonAssumptions {
  /** Fraction, 0–1. The largest source of error, stated rather than hidden. */
  cpuUtilization: number;
  /** PUE per provider that contributed to this estimate. */
  pue: Record<string, number>;
  /** Watts per vCPU per provider that contributed. */
  vcpuWatts: Record<string, { min: number; max: number }>;
  coefficientSource: string;
  coefficientVintage: string;
  /** What the estimate covers, in one sentence a reader can check. */
  scope: string;
}

export const CARBON_COEFFICIENT_SOURCE =
  "Cloud Carbon Footprint coefficients (Apache-2.0), from government and grid-operator publications";
export const CARBON_COEFFICIENT_VINTAGE = "2024 coefficient set";
export const CARBON_SCOPE =
  "Operational emissions of compute only. Storage, network egress, managed services and embodied (manufacturing) emissions are not included.";

export const CARBON_LIMITS = {
  defaultWindowDays: 30,
  minWindowDays: 1,
  maxWindowDays: 365,
  maxRows: 500,
  maxUnestimated: 200,
} as const;

/**
 * Watts one vCPU draws at the assumed utilisation.
 *
 * Linear between idle and full load, which is the upstream model. Real
 * processors are not linear, but the error from that is far smaller than the
 * error from assuming a utilisation at all — and pretending otherwise would be
 * precision theatre.
 */
export function wattsPerVcpu(pluginId: string, utilization: number): number | null {
  const watts = VCPU_WATTS[pluginId];
  if (!watts) return null;
  const clamped = Math.max(0, Math.min(1, utilization));
  return watts.min + clamped * (watts.max - watts.min);
}

/** Why this resource cannot be estimated, or null when it can. */
export function unestimatableReason(
  resource: Pick<CarbonInputResource, "pluginId" | "region" | "vcpus">,
): CarbonUnestimatedReason | null {
  if (!PROVIDER_PUE[resource.pluginId]) return "unsupported-provider";
  if (gridIntensityFor(resource.pluginId, resource.region) === null) return "unknown-region";
  if (resource.vcpus === null || !Number.isFinite(resource.vcpus) || resource.vcpus <= 0) {
    return "unknown-size";
  }
  return null;
}

/**
 * One resource's estimate, or null when it cannot be made.
 *
 * The order of the checks matters for the *reason*: an unsupported provider has
 * no region table at all, so checking region first would report every Fly.io
 * machine as "unknown region" and send somebody looking for a region mapping
 * that was never the problem.
 */
export function estimateResourceCarbon(
  resource: CarbonInputResource,
  options: { windowDays: number; utilization?: number },
): CarbonRow | null {
  if (unestimatableReason(resource) !== null) return null;
  const utilization = options.utilization ?? ASSUMED_CPU_UTILIZATION;
  const watts = wattsPerVcpu(resource.pluginId, utilization);
  const intensity = gridIntensityFor(resource.pluginId, resource.region);
  const pue = PROVIDER_PUE[resource.pluginId];
  if (watts === null || intensity === null || pue === undefined || resource.vcpus === null) {
    return null;
  }

  const hours = options.windowDays * 24;
  const kwh = (resource.vcpus * watts * hours * pue) / 1000;
  return {
    resourceId: resource.resourceId,
    displayName: resource.displayName,
    pluginId: resource.pluginId,
    accountId: resource.accountId,
    accountName: resource.accountName,
    region: resource.region,
    vcpus: resource.vcpus,
    gridIntensity: intensity,
    kwh,
    // grams → kilograms.
    kgCo2e: (kwh * intensity) / 1000,
  };
}

function group(
  rows: readonly CarbonRow[],
  keyOf: (row: CarbonRow) => { key: string; label: string },
): CarbonGroup[] {
  const map = new Map<string, CarbonGroup>();
  for (const row of rows) {
    const { key, label } = keyOf(row);
    const existing = map.get(key);
    if (existing) {
      existing.kgCo2e += row.kgCo2e;
      existing.kwh += row.kwh;
      existing.resourceCount += 1;
    } else {
      map.set(key, { key, label, kgCo2e: row.kgCo2e, kwh: row.kwh, resourceCount: 1 });
    }
  }
  return [...map.values()].sort((a, b) => b.kgCo2e - a.kgCo2e || a.key.localeCompare(b.key));
}

/** Estimate the whole estate, with the rows that could not be estimated named. */
export function estimateCarbon(
  resources: readonly CarbonInputResource[],
  options: { windowDays?: number; utilization?: number; now?: number } = {},
): CarbonEstimate {
  const windowDays = Math.min(
    Math.max(options.windowDays ?? CARBON_LIMITS.defaultWindowDays, CARBON_LIMITS.minWindowDays),
    CARBON_LIMITS.maxWindowDays,
  );
  const utilization = options.utilization ?? ASSUMED_CPU_UTILIZATION;

  const rows: CarbonRow[] = [];
  const unestimated: CarbonUnestimatedRow[] = [];
  const pluginsSeen = new Set<string>();

  for (const resource of resources) {
    const reason = unestimatableReason(resource);
    if (reason !== null) {
      unestimated.push({
        resourceId: resource.resourceId,
        displayName: resource.displayName,
        pluginId: resource.pluginId,
        accountId: resource.accountId,
        accountName: resource.accountName,
        region: resource.region,
        reason,
      });
      continue;
    }
    const row = estimateResourceCarbon(resource, { windowDays, utilization });
    if (row) {
      rows.push(row);
      pluginsSeen.add(resource.pluginId);
    }
  }

  rows.sort((a, b) => b.kgCo2e - a.kgCo2e || a.resourceId.localeCompare(b.resourceId));

  const pue: Record<string, number> = {};
  const vcpuWatts: Record<string, { min: number; max: number }> = {};
  for (const pluginId of pluginsSeen) {
    const providerPue = PROVIDER_PUE[pluginId];
    const watts = VCPU_WATTS[pluginId];
    if (providerPue !== undefined) pue[pluginId] = providerPue;
    if (watts) vcpuWatts[pluginId] = watts;
  }

  return {
    windowDays,
    totalKgCo2e: rows.reduce((sum, row) => sum + row.kgCo2e, 0),
    totalKwh: rows.reduce((sum, row) => sum + row.kwh, 0),
    estimatedCount: rows.length,
    unestimated: unestimated.slice(0, CARBON_LIMITS.maxUnestimated),
    byRegion: group(rows, (row) => ({
      key: `${row.pluginId}:${row.region ?? ""}`,
      label: `${row.pluginId} ${row.region ?? ""}`.trim(),
    })),
    byAccount: group(rows, (row) => ({
      key: row.accountId,
      label: row.accountName ?? row.accountId,
    })),
    rows: rows.slice(0, CARBON_LIMITS.maxRows),
    assumptions: {
      cpuUtilization: utilization,
      pue,
      vcpuWatts,
      coefficientSource: CARBON_COEFFICIENT_SOURCE,
      coefficientVintage: CARBON_COEFFICIENT_VINTAGE,
      scope: CARBON_SCOPE,
    },
    generatedAt: new Date(options.now ?? Date.now()).toISOString(),
  };
}

/** "12.4 kg" / "1.2 t" — a mass a person can hold in their head. */
export function formatCo2e(kg: number): string {
  if (!Number.isFinite(kg)) return "—";
  if (kg >= 1000) return `${(kg / 1000).toFixed(1)} t`;
  if (kg >= 10) return `${Math.round(kg)} kg`;
  return `${kg.toFixed(1)} kg`;
}

/** Human label for why a resource has no estimate. */
export const CARBON_UNESTIMATED_LABELS: Record<CarbonUnestimatedReason, string> = {
  "unsupported-provider": "No published grid figures for this provider",
  "unknown-region": "This region is not in the published coefficient set",
  "unknown-size": "No vCPU count synced for this resource",
};
