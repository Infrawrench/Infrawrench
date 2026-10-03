/**
 * The carbon estimate: CO2e beside the cost, with its assumptions on screen.
 *
 * This is an **estimate**, in the same sense the cost estimates already in this
 * product are, and it is built to be honest about that in three specific ways:
 *
 * 1. **A resource we cannot place is never guessed.** No region in the table,
 *    no vCPU count, a grid with no published figures: each produces an
 *    `unestimated` row with a stated reason, and contributes nothing to the
 *    total. A carbon figure computed against a guessed grid is worse than no
 *    figure, because it is a number somebody will put in a report.
 * 2. **The assumptions travel with the answer.** Utilisation, PUE and the
 *    coefficient vintage are on the response, not buried in a constant.
 * 3. **It covers processors and says so.** Storage, network, memory and
 *    embodied emissions are out of scope; reporting a total that silently
 *    omitted them while looking complete would be the same failure in a
 *    different place.
 *
 * The arithmetic is the Cloud Carbon Footprint operational formula:
 * `vCPUs × watts(utilisation) × hours × PUE ÷ 1000 × gridIntensity`.
 *
 * Every surface that shows a price shows this beside it, through the helpers
 * here: the org estimate (`estimateCarbon`), one resource
 * (`estimateFootprint`), a create form (`estimateCreateFormCarbon`, which
 * needs no request because the size-picker already carries vCPUs) and the
 * right-sizing saving (`carbonSaving`). Plugins declare which fields to read
 * (`CarbonDeclaration`); `readCarbonInputs` reads them.
 */
import type {
  CarbonDeclaration,
  CreateCarbonHint,
  CreateResourceConfig,
  SizeOption,
} from "@infrawrench/plugin-base";
import {
  ASSUMED_CPU_UTILIZATION,
  isSupportedCarbonGrid,
  pueFor,
  resolveCarbonGrid,
  vcpuWattsFor,
  type GridBasis,
} from "./carbon-factors";

export type CarbonUnestimatedReason = "unsupported-provider" | "unknown-region" | "unknown-size";

export type CarbonRole = "instance" | "aggregate";

/** Hours in an average month, the convention every monthly price here uses. */
export const HOURS_PER_MONTH = 730;

export interface CarbonInputResource {
  resourceId: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  accountName: string | null;
  displayName: string;
  /** Coefficient table to resolve the region in: a plugin id, or "auto". */
  grid: string;
  /** Provider region as synced, in whatever form the plugin reports it. */
  region: string | null;
  /** vCPUs per unit, when the type declares where to read them. */
  vcpus: number | null;
  /** Units (nodes, workers). Defaults to one. */
  count?: number | undefined;
}

/** One resource's (or one configuration's) footprint over a window. */
export interface CarbonFootprint {
  /** vCPUs per unit. */
  vcpus: number;
  /** Units the figure covers (node count); 1 for a single machine. */
  count: number;
  region: string;
  /** The table the region resolved in ("aws", "hetzner"...). */
  grid: string;
  /** Grams CO2e per kWh used: the published number, not a band. */
  gridIntensity: number;
  /** What the grid figure describes ("Germany", "aws eu-west-1"). */
  gridZone: string;
  gridBasis: GridBasis;
  pue: number;
  kwh: number;
  kgCo2e: number;
}

export interface CarbonRow extends CarbonFootprint {
  resourceId: string;
  displayName: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  accountName: string | null;
}

export interface CarbonUnestimatedRow {
  resourceId: string;
  displayName: string;
  pluginId: string;
  resourceTypeId: string;
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

export interface CarbonAssumptions {
  /** Fraction, 0–1. The largest source of error, stated rather than hidden. */
  cpuUtilization: number;
  /** Fleet PUE per contributing grid (regional figures are on each row). */
  pue: Record<string, number>;
  /** Watts per vCPU per contributing grid. */
  vcpuWatts: Record<string, { min: number; max: number }>;
  coefficientSource: string;
  coefficientVintage: string;
  /** What the estimate covers, in one sentence a reader can check. */
  scope: string;
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
  /** Total unestimated, when `unestimated` was truncated. */
  unestimatedCount: number;
  /**
   * Kubernetes nodes whose machine is already counted as an instance in its
   * own right (a GKE node is also a GCE instance). Counted once, and the
   * number skipped is said rather than hidden.
   */
  duplicateCount: number;
  byRegion: CarbonGroup[];
  byAccount: CarbonGroup[];
  byProvider: CarbonGroup[];
  rows: CarbonRow[];
  assumptions: CarbonAssumptions;
  generatedAt: string;
}

/** The per-resource answer: a footprint, or the reason there is none. */
export interface ResourceCarbonEstimate {
  /** Monthly footprint (730 hours), or null when it cannot be estimated. */
  estimate: CarbonFootprint | null;
  /** Why not, when `estimate` is null; null when the type is out of scope. */
  reason: CarbonUnestimatedReason | null;
  /** False when this type has no carbon declaration at all. */
  inScope: boolean;
  role: CarbonRole;
  assumptions: Pick<
    CarbonAssumptions,
    "cpuUtilization" | "coefficientSource" | "coefficientVintage" | "scope"
  >;
}

export const CARBON_COEFFICIENT_SOURCE =
  "Cloud Carbon Footprint (AWS, GCP, Azure); Ember 2024 elsewhere";
export const CARBON_COEFFICIENT_VINTAGE = "CCF April 2026, Ember 2024";
export const CARBON_SCOPE =
  "Processors only; storage, memory, network and manufacturing are not included.";

export const CARBON_LIMITS = {
  defaultWindowDays: 30,
  minWindowDays: 1,
  maxWindowDays: 365,
  maxRows: 500,
  maxUnestimated: 200,
} as const;

/** The assumptions block every per-resource answer carries. */
export const CARBON_RESOURCE_ASSUMPTIONS: ResourceCarbonEstimate["assumptions"] = {
  cpuUtilization: ASSUMED_CPU_UTILIZATION,
  coefficientSource: CARBON_COEFFICIENT_SOURCE,
  coefficientVintage: CARBON_COEFFICIENT_VINTAGE,
  scope: CARBON_SCOPE,
};

/**
 * Watts one vCPU draws at the assumed utilisation.
 *
 * Linear between idle and full load, which is the upstream model. Real
 * processors are not linear, but the error from that is far smaller than the
 * error from assuming a utilisation at all, and pretending otherwise would be
 * precision theatre.
 */
export function wattsPerVcpu(grid: string, utilization: number): number {
  const watts = vcpuWattsFor(grid);
  const clamped = Math.max(0, Math.min(1, utilization));
  return watts.min + clamped * (watts.max - watts.min);
}

function validVcpus(vcpus: number | null | undefined): vcpus is number {
  return typeof vcpus === "number" && Number.isFinite(vcpus) && vcpus > 0;
}

function validCount(count: number | undefined): number {
  return typeof count === "number" && Number.isFinite(count) && count >= 0 ? Math.floor(count) : 1;
}

/**
 * Why this configuration cannot be estimated, or null when it can.
 *
 * The order of the checks matters for the *reason*: a grid with no table at
 * all has no regions, so checking region first would report every resource of
 * an unsupported provider as "unknown region" and send somebody looking for a
 * region mapping that was never the problem.
 */
export function unestimatableReason(input: {
  grid: string;
  region: string | null;
  vcpus: number | null;
}): CarbonUnestimatedReason | null {
  if (!isSupportedCarbonGrid(input.grid)) return "unsupported-provider";
  if (resolveCarbonGrid(input.grid, input.region) === null) return "unknown-region";
  if (!validVcpus(input.vcpus)) return "unknown-size";
  return null;
}

/**
 * One configuration's footprint over `hours`, or null when it cannot be
 * placed. The single place the formula lives; every surface calls this.
 */
export function estimateFootprint(
  input: { grid: string; region: string | null; vcpus: number | null; count?: number | undefined },
  options: { hours?: number; utilization?: number } = {},
): CarbonFootprint | null {
  if (!validVcpus(input.vcpus) || !input.region) return null;
  const resolved = resolveCarbonGrid(input.grid, input.region);
  if (!resolved) return null;
  const hours = options.hours ?? HOURS_PER_MONTH;
  const utilization = options.utilization ?? ASSUMED_CPU_UTILIZATION;
  const count = validCount(input.count);
  const pue = pueFor(resolved.grid, input.region);
  const kwh = (input.vcpus * count * wattsPerVcpu(resolved.grid, utilization) * hours * pue) / 1000;
  return {
    vcpus: input.vcpus,
    count,
    region: input.region,
    grid: resolved.grid,
    gridIntensity: resolved.figure.gPerKwh,
    gridZone: resolved.figure.zone,
    gridBasis: resolved.figure.basis,
    pue,
    kwh,
    // grams → kilograms.
    kgCo2e: (kwh * resolved.figure.gPerKwh) / 1000,
  };
}

/** Back-compat name for one inventory row's estimate over a window. */
export function estimateResourceCarbon(
  resource: CarbonInputResource,
  options: { windowDays: number; utilization?: number },
): CarbonRow | null {
  const footprint = estimateFootprint(resource, {
    hours: options.windowDays * 24,
    ...(options.utilization !== undefined ? { utilization: options.utilization } : {}),
  });
  if (!footprint) return null;
  return {
    ...footprint,
    resourceId: resource.resourceId,
    displayName: resource.displayName,
    pluginId: resource.pluginId,
    resourceTypeId: resource.resourceTypeId,
    accountId: resource.accountId,
    accountName: resource.accountName,
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
  options: {
    windowDays?: number;
    utilization?: number;
    now?: number;
    duplicateCount?: number;
  } = {},
): CarbonEstimate {
  const windowDays = Math.min(
    Math.max(options.windowDays ?? CARBON_LIMITS.defaultWindowDays, CARBON_LIMITS.minWindowDays),
    CARBON_LIMITS.maxWindowDays,
  );
  const utilization = options.utilization ?? ASSUMED_CPU_UTILIZATION;

  const rows: CarbonRow[] = [];
  const unestimated: CarbonUnestimatedRow[] = [];
  const gridsSeen = new Set<string>();

  for (const resource of resources) {
    const reason = unestimatableReason(resource);
    const row =
      reason === null ? estimateResourceCarbon(resource, { windowDays, utilization }) : null;
    if (!row) {
      unestimated.push({
        resourceId: resource.resourceId,
        displayName: resource.displayName,
        pluginId: resource.pluginId,
        resourceTypeId: resource.resourceTypeId,
        accountId: resource.accountId,
        accountName: resource.accountName,
        region: resource.region,
        reason: reason ?? "unknown-region",
      });
      continue;
    }
    rows.push(row);
    gridsSeen.add(row.grid);
  }

  rows.sort((a, b) => b.kgCo2e - a.kgCo2e || a.resourceId.localeCompare(b.resourceId));

  const pue: Record<string, number> = {};
  const vcpuWatts: Record<string, { min: number; max: number }> = {};
  for (const grid of gridsSeen) {
    pue[grid] = pueFor(grid, null);
    vcpuWatts[grid] = vcpuWattsFor(grid);
  }

  return {
    windowDays,
    totalKgCo2e: rows.reduce((sum, row) => sum + row.kgCo2e, 0),
    totalKwh: rows.reduce((sum, row) => sum + row.kwh, 0),
    estimatedCount: rows.length,
    unestimated: unestimated.slice(0, CARBON_LIMITS.maxUnestimated),
    unestimatedCount: unestimated.length,
    duplicateCount: options.duplicateCount ?? 0,
    byRegion: group(rows, (row) => ({
      key: `${row.grid}:${row.region}`,
      label: `${row.grid} ${row.region}`,
    })),
    byAccount: group(rows, (row) => ({
      key: row.accountId,
      label: row.accountName ?? row.accountId,
    })),
    byProvider: group(rows, (row) => ({ key: row.pluginId, label: row.pluginId })),
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

// ── Reading a resource ───────────────────────────────────────────────────────

/** The fields of a type definition the carbon estimate reads. */
export interface CarbonTypeShape {
  carbon?: CarbonDeclaration | undefined;
  rightsizing?:
    { sizeFieldKey: string; createSizeFieldKey?: string; regionFieldKey?: string } | undefined;
}

/**
 * The declaration to read a type with: its own `carbon`, else one derived
 * from `rightsizing` (which already names the size and region fields and the
 * create form's size-picker), else null: the type is out of scope.
 */
export function effectiveCarbonDeclaration(type: CarbonTypeShape): CarbonDeclaration | null {
  if (type.carbon) return type.carbon;
  const rs = type.rightsizing;
  if (!rs?.regionFieldKey) return null;
  return {
    regionFieldKey: rs.regionFieldKey,
    vcpus: {
      from: "size",
      sizeFieldKey: rs.sizeFieldKey,
      ...(rs.createSizeFieldKey ? { catalogueFieldKey: rs.createSizeFieldKey } : {}),
    },
  };
}

/**
 * Look up a field on a resource's stored fields, case-insensitively.
 *
 * Plugins are inconsistent about casing for the same concept (`vmSize` vs
 * `vm_size`), and the declaration names one spelling. Matching loosely here
 * costs nothing and avoids a whole class of "why is this resource unestimated"
 * that has nothing to do with carbon.
 */
export function readCarbonField(fields: Record<string, unknown>, key: string): string | null {
  const pick = (value: unknown): string | null => {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return null;
  };
  const direct = pick(fields[key]);
  if (direct !== null) return direct;
  const lower = key.toLowerCase();
  for (const [name, value] of Object.entries(fields)) {
    if (name.toLowerCase() === lower) {
      const hit = pick(value);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/** A Kubernetes CPU quantity ("4", "3920m", "0.5") as cores, or null. */
export function parseCpuQuantity(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(m?)$/.exec(raw.trim());
  if (!m) return null;
  const value = Number(m[1]);
  return m[2] === "m" ? value / 1000 : value;
}

/**
 * Size catalogue lookup the host supplies: the size-picker options of
 * `typeId`'s create form at `fieldKey`, or null. Hosts cache this per
 * (account, type); a catalogue that fails returns null and its resources come
 * back `unknown-size`, never a failed report.
 */
export type CarbonCatalogueLoader = (
  typeId: string,
  fieldKey: string,
) => Promise<ReadonlyArray<Pick<SizeOption, "id" | "label" | "vcpus">> | null>;

/** Normalise a stored size value the way the declaration says to. */
function sizeKey(raw: string, source: Extract<CarbonDeclaration["vcpus"], { from: "size" }>) {
  let value = source.list ? (raw.split(",")[0] ?? "").trim() : raw;
  if (source.stripPrefix && value.startsWith(source.stripPrefix)) {
    value = value.slice(source.stripPrefix.length);
  }
  if (source.stripSuffix && value.endsWith(source.stripSuffix)) {
    value = value.slice(0, -source.stripSuffix.length);
  }
  return value;
}

/** The resolved inputs for one resource. */
export interface CarbonResourceInputs {
  grid: string;
  region: string | null;
  vcpus: number | null;
  count: number;
  role: CarbonRole;
}

/**
 * Read one resource's carbon inputs through its declaration. Pure apart from
 * `loadCatalogue`, so the web service, the desktop's local mode and the
 * environment estimate all read resources the same way.
 */
export async function readCarbonInputs(
  declaration: CarbonDeclaration,
  fields: Record<string, unknown>,
  ctx: { pluginId: string; resourceTypeId: string; loadCatalogue: CarbonCatalogueLoader },
): Promise<CarbonResourceInputs> {
  const grid =
    (declaration.gridFieldKey
      ? readCarbonField(fields, declaration.gridFieldKey)?.toLowerCase()
      : undefined) ??
    declaration.grid ??
    ctx.pluginId;
  const region = readCarbonField(fields, declaration.regionFieldKey);

  let count = 1;
  if (declaration.countFieldKey) {
    const raw = Number(readCarbonField(fields, declaration.countFieldKey));
    count = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 1;
  }
  count += declaration.countOffset ?? 0;

  let vcpus: number | null = null;
  const source = declaration.vcpus;
  if (source.from === "field") {
    const raw = readCarbonField(fields, source.fieldKey);
    if (raw !== null) {
      vcpus = source.format === "k8s-quantity" ? parseCpuQuantity(raw) : Number(raw);
      if (!validVcpus(vcpus)) vcpus = null;
    }
  } else {
    const raw = readCarbonField(fields, source.sizeFieldKey);
    if (raw !== null) {
      const wanted = sizeKey(raw, source).toLowerCase();
      const sizes = await ctx.loadCatalogue(
        source.catalogueTypeId ?? ctx.resourceTypeId,
        source.catalogueFieldKey ?? source.sizeFieldKey,
      );
      const hit = sizes?.find(
        (s) => (source.matchBy === "label" ? s.label : s.id).toLowerCase() === wanted,
      );
      vcpus = hit && validVcpus(hit.vcpus) ? hit.vcpus : null;
    }
  }

  return { grid, region, vcpus, count, role: declaration.role ?? "instance" };
}

/** Turn resolved inputs into the per-resource answer. */
export function resourceCarbonEstimate(
  inputs: CarbonResourceInputs | null,
): ResourceCarbonEstimate {
  if (!inputs) {
    return {
      estimate: null,
      reason: null,
      inScope: false,
      role: "instance",
      assumptions: CARBON_RESOURCE_ASSUMPTIONS,
    };
  }
  const reason = unestimatableReason(inputs);
  const estimate = reason === null ? estimateFootprint(inputs) : null;
  return {
    estimate,
    reason: estimate ? null : (reason ?? "unknown-region"),
    inScope: true,
    role: inputs.role,
    assumptions: CARBON_RESOURCE_ASSUMPTIONS,
  };
}

/** The hint the create form reads, from a type's declaration. */
export function createCarbonHint(
  pluginId: string,
  type: CarbonTypeShape,
): CreateCarbonHint | undefined {
  const declaration = effectiveCarbonDeclaration(type);
  if (!declaration) return undefined;
  const source = declaration.vcpus;
  // Only a size read from this type's own form can be estimated before the
  // resource exists; a borrowed catalogue (RDS reading EC2's) has no picker
  // on this form, and a vCPU field is only known once the resource is synced.
  if (source.from !== "size" || source.catalogueTypeId) return undefined;
  return {
    grid: declaration.grid ?? pluginId,
    role: declaration.role ?? "instance",
    sizeFieldKey: source.catalogueFieldKey ?? source.sizeFieldKey,
    ...(declaration.countFieldKey ? { countFieldKey: declaration.countFieldKey } : {}),
  };
}

/** The region a create form has picked, for a hint. */
export function createFormRegion(
  config: CreateResourceConfig,
  fields: Record<string, string>,
): string | null {
  const hint = config.carbon;
  // A region-picker first; failing that, a plain select keyed the way every
  // plugin names the concept (Scaleway's zone, Azure's location).
  const key =
    hint?.regionFieldKey ??
    config.fields.find((f) => f.kind === "region-picker")?.key ??
    config.fields.find((f) => ["region", "zone", "location"].includes(f.key))?.key ??
    null;
  const value = key ? fields[key] : undefined;
  return value && value.trim() ? value.trim() : null;
}

/**
 * The monthly footprint of what a create form currently describes, or null.
 * Needs no request: the size-picker already carries each size's vCPUs, and
 * the region is a field on the form.
 */
export function estimateCreateFormCarbon(
  config: CreateResourceConfig,
  fields: Record<string, string>,
): CarbonFootprint | null {
  const hint = config.carbon;
  if (!hint) return null;
  const sizeField = config.fields.find(
    (f) =>
      f.kind === "size-picker" &&
      f.sizes?.length &&
      (!hint.sizeFieldKey || f.key === hint.sizeFieldKey),
  );
  const sizeId = sizeField ? fields[sizeField.key] : undefined;
  const size = sizeId ? sizeField?.sizes?.find((s) => s.id === sizeId) : undefined;
  if (!size) return null;
  const rawCount = hint.countFieldKey ? Number(fields[hint.countFieldKey]) : 1;
  return estimateFootprint({
    grid: hint.grid,
    region: createFormRegion(config, fields),
    vcpus: size.vcpus,
    count: Number.isFinite(rawCount) && rawCount >= 0 ? rawCount : 1,
  });
}

/**
 * Monthly kg CO2e one size would emit in a region, for a size card. Null when
 * the region cannot be placed.
 */
export function monthlyCarbonForSize(
  hint: CreateCarbonHint | undefined,
  region: string | null,
  vcpus: number,
): number | null {
  if (!hint) return null;
  return estimateFootprint({ grid: hint.grid, region, vcpus })?.kgCo2e ?? null;
}

/**
 * Monthly kg CO2e a resize would save, for right-sizing. Null when either size
 * cannot be placed. Same region, same grid, so the saving is the vCPU
 * difference and nothing else.
 */
export function carbonSaving(input: {
  grid: string;
  region: string | null;
  currentVcpus: number;
  recommendedVcpus: number;
}): { currentMonthlyKgCo2e: number; monthlyKgCo2eSaving: number } | null {
  const current = estimateFootprint({
    grid: input.grid,
    region: input.region,
    vcpus: input.currentVcpus,
  });
  const recommended = estimateFootprint({
    grid: input.grid,
    region: input.region,
    vcpus: input.recommendedVcpus,
  });
  if (!current || !recommended) return null;
  return {
    currentMonthlyKgCo2e: current.kgCo2e,
    monthlyKgCo2eSaving: Math.max(0, current.kgCo2e - recommended.kgCo2e),
  };
}

// ── Formatting ───────────────────────────────────────────────────────────────

/** "12.4 kg" / "1.2 t" / "340 g": a mass a person can hold in their head. */
export function formatCo2e(kg: number): string {
  if (!Number.isFinite(kg)) return "n/a";
  if (kg >= 1000) return `${(kg / 1000).toFixed(1)} t`;
  if (kg >= 10) return `${Math.round(kg)} kg`;
  if (kg >= 1) return `${kg.toFixed(1)} kg`;
  if (kg > 0) return `${Math.round(kg * 1000)} g`;
  return "0 kg";
}

/** "~12 kg CO2e/mo": the chip beside a monthly price. */
export function formatMonthlyCo2e(kg: number): string {
  return `~${formatCo2e(kg)} CO2e/mo`;
}

/** "+3.1 kg CO2e/mo" / "-3.1 kg CO2e/mo" for an edit's delta. */
export function formatMonthlyCo2eDelta(kg: number): string {
  if (!Number.isFinite(kg) || Math.abs(kg) < 0.0005) return "no change in CO2e";
  return `${kg > 0 ? "+" : "-"}${formatCo2e(Math.abs(kg))} CO2e/mo`;
}

/** Human label for why a resource has no estimate. */
export const CARBON_UNESTIMATED_LABELS: Record<CarbonUnestimatedReason, string> = {
  "unsupported-provider": "No grid data for this provider",
  "unknown-region": "Region not covered",
  "unknown-size": "Size unknown",
};

/** One sentence on what a footprint rests on, for a tooltip or CLI line. */
export function describeFootprint(f: CarbonFootprint): string {
  const units = f.count === 1 ? `${f.vcpus} vCPU` : `${f.count} × ${f.vcpus} vCPU`;
  return `${units} in ${f.gridZone} at ${Math.round(f.gridIntensity)} g/kWh, PUE ${f.pue}, ${Math.round(
    ASSUMED_CPU_UTILIZATION * 100,
  )}% utilisation`;
}
