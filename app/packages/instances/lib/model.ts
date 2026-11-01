import type { AttributeChange, DecodedInstance, Region, ReservedTerm } from "./decode";
import type { FxRates } from "./fx";
import { parseName, sizeRank } from "./names";
import { DEFAULT_REGION_CODE, type PlatformInfo } from "./platforms";

/**
 * What an instance page sends the browser. The full history of a busy instance
 * (m5.large has about 20,000 price rows across 33 regions and 102 variants) is
 * far too big to ship whole, so the page carries the current prices everywhere
 * and the full price history of one region; the rest is fetched per region from
 * `/api/aws/<platform>/<instance>/<region>` as the visitor switches.
 */
export interface InstanceModel {
  platform: string;
  platformLabel: string;
  name: string;
  createdAt: number;
  deletedAt: number | null;
  /** Unix seconds of the newest price list the data was built from. */
  asOf: number;
  regions: RegionInfo[];
  variantKeys: string[];
  /** Indices of the variant keys that tell variants apart; the others follow from these. */
  shownKeys: number[];
  /** Each variant's values, in `variantKeys` order. */
  variants: string[][];
  terms: ReservedTerm[];
  attributes: AttributeChange[];
  /** Current on-demand USD per hour, per region (by index), as `[variant, hourly]` pairs. */
  current: [number, number][][];
  /** How many regions offered the instance (in any variant) over time, as `[at, count]`. */
  availability: [number, number][];
  defaultRegion: number;
  defaultVariant: number;
  regionData: RegionData;
  /** Every size in this instance's family, smallest first. */
  family: FamilyMember[];
  /** The same size (or the nearest) in sibling families of the same generation, e.g. m5a and m5d for m5. */
  related: { family: string; name: string }[];
  /** For showing prices in other currencies; `null` when the rates could not be read. */
  fx: FxRates | null;
  /** EC2 spot prices; `null` on other platforms, or when there are none for this instance. */
  spot: SpotModel | null;
}

/**
 * EC2 spot prices, from the spot bundle's instance of the same name. AWS sells
 * spot only as {@link SPOT_VARIANT}, for the operating systems in `systems`.
 */
export interface SpotModel {
  /** Each spot variant's operating system (`Linux`, `Windows`), as EC2's `operatingSystem` spells it. */
  systems: string[];
  /**
   * Current spot USD per hour, per region (by index into the instance's
   * regions), as `[system, hourly]` pairs: the lowest price across the region's
   * availability zones, as AWS's Spot pricing page shows it.
   */
  current: [number, number][][];
  /** Unix seconds of the newest spot prices. */
  asOf: number;
}

/** The EC2 variant fields spot prices apply to, besides the operating system. */
const SPOT_VARIANT: Readonly<Record<string, string>> = {
  tenancy: "Shared",
  licenseModel: "No License required",
  preInstalledSw: "NA",
  capacitystatus: "Used",
};

/** The spot system (index into `spot.systems`) priced like this variant, or -1 when spot does not apply. */
export function spotSystem(
  m: Pick<InstanceModel, "spot" | "variantKeys" | "variants">,
  variant: number,
): number {
  const fields = m.variants[variant];
  if (!m.spot || !fields) return -1;
  for (const [key, value] of Object.entries(SPOT_VARIANT)) {
    const k = m.variantKeys.indexOf(key);
    if (k >= 0 && fields[k] !== value) return -1;
  }
  const os = m.variantKeys.indexOf("operatingSystem");
  return os < 0 ? -1 : m.spot.systems.indexOf(fields[os]!);
}

/** Where each of the spot bundle's locations is in the instance's regions, by region code; -1 if absent. */
function spotRegions(spot: DecodedInstance, regions: Region[]): number[] {
  const byCode = new Map<string, number>();
  regions.forEach((r, i) => {
    if (r.code) byCode.set(r.code, i);
  });
  // Spot locations are region codes; older spot bundles give no regionCode attribute.
  return spot.regions.map((r) => byCode.get(r.code ?? r.name) ?? -1);
}

function buildSpot(spot: DecodedInstance, regions: Region[], asOf: number): SpotModel {
  const at = spotRegions(spot, regions);
  const latest = new Map<string, { region: number; variant: number; hourly: number | null }>();
  for (const r of spot.onDemand) latest.set(`${r.region}:${r.variant}`, r);
  const current: [number, number][][] = regions.map(() => []);
  for (const r of latest.values()) {
    const i = at[r.region] ?? -1;
    if (i >= 0 && r.hourly !== null) current[i]!.push([r.variant, r.hourly]);
  }
  for (const pairs of current) pairs.sort((a, b) => a[0] - b[0]);
  const os = Math.max(spot.variantKeys.indexOf("operatingSystem"), 0);
  return { systems: spot.variants.map((v) => v[os] ?? ""), current, asOf };
}

export interface RegionInfo extends Region {
  /** What the URL calls it: the region code, or the location name when there is none. */
  id: string;
}

export interface FamilyMember {
  name: string;
  vcpu?: string;
  memory?: string;
}

/** One region's full price history. */
export interface RegionData {
  region: number;
  /** Variant to `[at, hourly]` rows, oldest first; `null` means no longer offered. */
  onDemand: Record<number, [number, number | null][]>;
  /** `<variant>:<term>` to `[at, hourly, upfront]` rows, oldest first. */
  reserved: Record<string, [number, number | null, number | null][]>;
  /** Spot system (index into `SpotModel.systems`) to `[at, hourly]` rows, oldest first; EC2 only. */
  spot?: Record<number, [number, number | null][]>;
}

export function regionInfo(regions: Region[]): RegionInfo[] {
  return regions.map((r) => ({ ...r, id: r.code ?? r.name }));
}

export function findRegion(regions: RegionInfo[], id: string): number {
  return regions.findIndex((r) => r.id === id);
}

/** One region's full price history; `spot` is the EC2 instance's spot prices, when it has any. */
export function buildRegionData(
  d: DecodedInstance,
  region: number,
  spot?: DecodedInstance | null,
): RegionData {
  const onDemand: RegionData["onDemand"] = {};
  for (const r of d.onDemand) {
    if (r.region === region) (onDemand[r.variant] ??= []).push([r.at, r.hourly]);
  }
  const reserved: RegionData["reserved"] = {};
  for (const r of d.reserved) {
    if (r.region === region) {
      (reserved[`${r.variant}:${r.term}`] ??= []).push([r.at, r.hourly, r.upfront]);
    }
  }
  const out: RegionData = { region, onDemand, reserved };
  const code = d.regions[region]?.code;
  const s = spot && code ? spot.regions.findIndex((r) => (r.code ?? r.name) === code) : -1;
  if (spot && s >= 0) {
    const rows: NonNullable<RegionData["spot"]> = {};
    for (const r of spot.onDemand)
      if (r.region === s) (rows[r.variant] ??= []).push([r.at, r.hourly]);
    out.spot = rows;
  }
  return out;
}

/** Variant keys whose value is not already decided by the keys before them. */
export function distinguishingKeys(variants: string[][], keyCount: number): number[] {
  const shown: number[] = [];
  for (let k = 0; k < keyCount; k++) {
    const seen = new Map<string, string>();
    let decided = true;
    for (const v of variants) {
      const key = shown.map((s) => v[s]).join("\0");
      const prev = seen.get(key);
      if (prev === undefined) seen.set(key, v[k]!);
      else if (prev !== v[k]) {
        decided = false;
        break;
      }
    }
    if (!decided) shown.push(k);
  }
  return shown;
}

/** The latest on-demand price of every (region, variant) still offered. */
function currentPrices(d: DecodedInstance): [number, number][][] {
  const latest = new Map<string, { region: number; variant: number; hourly: number | null }>();
  for (const r of d.onDemand) latest.set(`${r.region}:${r.variant}`, r);
  const out: [number, number][][] = d.regions.map(() => []);
  for (const r of latest.values()) {
    if (r.hourly !== null) out[r.region]!.push([r.variant, r.hourly]);
  }
  for (const pairs of out) pairs.sort((a, b) => a[0] - b[0]);
  return out;
}

/** Regions offering any variant on demand, after each change. */
function availability(d: DecodedInstance): [number, number][] {
  const offered = new Map<string, boolean>();
  const perRegion = new Map<number, number>();
  let regions = 0;
  const out: [number, number][] = [];
  for (let i = 0; i < d.onDemand.length; i++) {
    const r = d.onDemand[i]!;
    const key = `${r.region}:${r.variant}`;
    const now = r.hourly !== null;
    if ((offered.get(key) ?? false) !== now) {
      offered.set(key, now);
      const before = perRegion.get(r.region) ?? 0;
      const after = before + (now ? 1 : -1);
      perRegion.set(r.region, after);
      if (before === 0 && after > 0) regions++;
      else if (before > 0 && after === 0) regions--;
    }
    // One point per timestamp, after all of its rows.
    if (d.onDemand[i + 1]?.at !== r.at && out.at(-1)?.[1] !== regions) out.push([r.at, regions]);
  }
  return out;
}

function pickDefaults(
  d: DecodedInstance,
  regions: RegionInfo[],
  current: [number, number][][],
  info: PlatformInfo,
): { region: number; variant: number } {
  const offeredIn = (i: number) => current[i]!.length;
  let region = regions.findIndex((r, i) => r.code === DEFAULT_REGION_CODE && offeredIn(i) > 0);
  if (region < 0) {
    region = 0;
    for (let i = 1; i < regions.length; i++) if (offeredIn(i) > offeredIn(region)) region = i;
  }

  const regionsOffering = new Map<number, number>();
  for (const pairs of current)
    for (const [v] of pairs) regionsOffering.set(v, (regionsOffering.get(v) ?? 0) + 1);
  const prefs = Object.entries(info.preferredVariant);
  const score = (v: number) =>
    prefs.reduce((sum, [key, value], i) => {
      const k = d.variantKeys.indexOf(key);
      return k >= 0 && d.variants[v]![k] === value ? sum + 2 ** (prefs.length - i) : sum;
    }, 0);

  const candidates =
    current[region]!.length > 0
      ? current[region]!
      : d.variants.map((_, v) => [v, Infinity] as [number, number]);
  let best = candidates[0]!;
  for (const c of candidates.slice(1)) {
    const diff =
      score(c[0]) - score(best[0]) ||
      (regionsOffering.get(c[0]) ?? 0) - (regionsOffering.get(best[0]) ?? 0) ||
      best[1] - c[1];
    if (diff > 0) best = c;
  }
  return { region, variant: best[0] };
}

/** The other sizes of the family and the same size in sibling families, from the platform's instance names. */
export function relatives(
  name: string,
  names: string[],
): { family: string[]; related: { family: string; name: string }[] } {
  const self = parseName(name);
  if (!self) return { family: [name], related: [] };
  const family: string[] = [];
  const byFamily = new Map<string, string[]>();
  for (const n of names) {
    const p = parseName(n);
    if (!p) continue;
    if (p.familyKey === self.familyKey) family.push(n);
    else if (p.generationKey === self.generationKey) {
      const list = byFamily.get(p.family) ?? [];
      list.push(n);
      byFamily.set(p.family, list);
    }
  }
  const bySize = (a: string, b: string) =>
    sizeRank(parseName(a)!.size) - sizeRank(parseName(b)!.size) || a.localeCompare(b);
  family.sort(bySize);
  const related = [...byFamily.entries()]
    .map(([fam, list]) => {
      // The same size if the family has it, else the nearest.
      const target = sizeRank(self.size);
      const pick = list.reduce((best, n) =>
        Math.abs(sizeRank(parseName(n)!.size) - target) <
        Math.abs(sizeRank(parseName(best)!.size) - target)
          ? n
          : best,
      );
      return { family: fam, name: pick };
    })
    .sort((a, b) => a.family.localeCompare(b.family));
  return { family, related };
}

/** The attributes in force at the end of the history, for every region. */
export function latestAttributes(changes: AttributeChange[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of changes) {
    if (c.region !== null) continue;
    if (c.value === null) delete out[c.key];
    else out[c.key] = c.value;
  }
  return out;
}

export function buildModel(
  d: DecodedInstance,
  info: PlatformInfo,
  opts: {
    asOf: number;
    family: FamilyMember[];
    related: { family: string; name: string }[];
    fx: FxRates | null;
    /** The spot bundle's instance of the same name, and when its prices are from. */
    spot?: { decoded: DecodedInstance; asOf: number } | null;
  },
): InstanceModel {
  const regions = regionInfo(d.regions);
  const current = currentPrices(d);
  const defaults = pickDefaults(d, regions, current, info);
  const offeredNow = [...new Set(current.flatMap((pairs) => pairs.map(([v]) => v)))].map(
    (v) => d.variants[v]!,
  );
  return {
    platform: d.platform,
    platformLabel: info.label,
    name: d.name,
    createdAt: d.createdAt,
    deletedAt: d.deletedAt,
    asOf: opts.asOf,
    regions,
    variantKeys: d.variantKeys,
    // Over what is offered today: retired variants would otherwise surface
    // pickers (RDS engine codes) whose only use is telling old products apart.
    shownKeys: distinguishingKeys(
      offeredNow.length > 0 ? offeredNow : d.variants,
      d.variantKeys.length,
    ),
    variants: d.variants,
    terms: d.terms,
    attributes: d.attributes,
    current,
    availability: availability(d),
    defaultRegion: defaults.region,
    defaultVariant: defaults.variant,
    regionData: buildRegionData(d, defaults.region, opts.spot?.decoded),
    family: opts.family,
    related: opts.related,
    fx: opts.fx,
    spot: opts.spot ? buildSpot(opts.spot.decoded, d.regions, opts.spot.asOf) : null,
  };
}
