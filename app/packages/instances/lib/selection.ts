import type { AttributeChange } from "./decode";
import type { InstanceModel } from "./model";

/** Variants with a current on-demand price in a region. */
export function offeredVariants(m: InstanceModel, region: number): Map<number, number> {
  return new Map(m.current[region] ?? []);
}

/** How closely two variants agree on the shown keys, earlier keys counting for more. */
function agreement(m: InstanceModel, a: number, b: number): number {
  const n = m.shownKeys.length;
  return m.shownKeys.reduce(
    (sum, k, i) => (m.variants[a]![k] === m.variants[b]![k] ? sum + 2 ** (n - i) : sum),
    0,
  );
}

function closest(m: InstanceModel, to: number, candidates: number[]): number | undefined {
  let best: number | undefined;
  let bestScore = -1;
  for (const c of candidates) {
    const score = agreement(m, to, c);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/** The variant itself if the region offers it, else the offered one most like it. */
export function closestOffered(m: InstanceModel, variant: number, region: number): number {
  const offered = offeredVariants(m, region);
  if (offered.size === 0 || offered.has(variant)) return variant;
  return closest(m, variant, [...offered.keys()]) ?? variant;
}

/** The variant to switch to when one field changes: same value for that field, as like the old one as possible. */
export function withField(
  m: InstanceModel,
  variant: number,
  key: number,
  value: string,
  region: number,
): number {
  const matching = m.variants.flatMap((v, i) => (v[key] === value ? [i] : []));
  const offered = offeredVariants(m, region);
  const pool = matching.filter((v) => offered.has(v));
  return closest(m, variant, pool.length > 0 ? pool : matching) ?? variant;
}

/** The values a field takes among the variants a region offers (all variants if it offers none). */
export function fieldOptions(m: InstanceModel, key: number, region: number): string[] {
  const offered = offeredVariants(m, region);
  const values = new Set<string>();
  m.variants.forEach((v, i) => {
    if (offered.size === 0 || offered.has(i)) values.add(v[key]!);
  });
  return [...values].sort((a, b) => a.localeCompare(b));
}

/**
 * The variants differing from `variant` only in field `key`, one per value,
 * that the region offers: what a "compare by" chart puts side by side.
 */
export function variantsAlong(
  m: InstanceModel,
  variant: number,
  key: number,
  region: number,
): number[] {
  const offered = offeredVariants(m, region);
  const others = m.shownKeys.filter((k) => k !== key);
  const base = m.variants[variant]!;
  return m.variants.flatMap((v, i) =>
    offered.has(i) && others.every((k) => v[k] === base[k]) ? [i] : [],
  );
}

export interface AttributeStep {
  at: number;
  /** `null` means the attribute was removed. */
  value: string | null;
  /** Whether this step came from a change to this region only. */
  regional: boolean;
}

/**
 * Each attribute's value over time in one region: global changes, with that
 * region's own changes on top. A regional change keeps applying even after a
 * newer global change to the same key. Only steps that change the value count.
 */
export function attributeTimelines(
  changes: AttributeChange[],
  region: number,
): Map<string, AttributeStep[]> {
  const global = new Map<string, string | null>();
  const local = new Map<string, string | null>();
  const out = new Map<string, AttributeStep[]>();
  for (const c of changes) {
    if (c.region !== null && c.region !== region) continue;
    const regional = c.region !== null;
    (regional ? local : global).set(c.key, c.value);
    const value = local.has(c.key) ? local.get(c.key)! : (global.get(c.key) ?? null);
    const steps = out.get(c.key) ?? [];
    const last = steps.at(-1);
    if (!last ? value !== null : last.value !== value) steps.push({ at: c.at, value, regional });
    out.set(c.key, steps);
  }
  return out;
}
