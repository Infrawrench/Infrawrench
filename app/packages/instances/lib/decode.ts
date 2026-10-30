/**
 * Decodes one instance's KV value: the instances-bundler's bundle format cut
 * down to a single instance (see `app/packages/web/src/aws-bulk-pricing/format.ts`
 * and the bundler's README for the format). Every string is an index into
 * `compression_table` and every timestamp is Unix seconds.
 */

/** The variant keys of EC2 bundles, which don't list their own. */
const EC2_VARIANT_KEYS = [
  "operatingSystem",
  "tenancy",
  "licenseModel",
  "preInstalledSw",
  "capacitystatus",
];

export interface InstanceFile {
  compression_table: string[];
  platform: string;
  offer: string;
  name: string;
  variant_keys?: string[];
  regions: [number, [number, number][]][];
  variants: number[][];
  reserved_terms: number[][];
  /** `[attrs, attrChanges, basePrice, onDemand, reserved, createdAt, deletedAt]`. */
  instance: [
    [number, number][],
    (number | null)[][],
    number,
    (number | null)[][],
    (number | null)[][],
    number,
    number | null,
  ];
}

export interface Region {
  /** The AWS location name, e.g. `US East (N. Virginia)`. */
  name: string;
  /** e.g. `us-east-1`; missing for locations the price list never gave a code. */
  code?: string;
  /** e.g. `AWS Region`, `AWS Local Zone`. */
  type?: string;
}

export interface ReservedTerm {
  /** `1yr` or `3yr`. */
  lease: string;
  /** `standard` or `convertible`. */
  offeringClass: string;
  /** `No Upfront`, `Partial Upfront` or `All Upfront`. */
  purchaseOption: string;
}

export interface AttributeChange {
  at: number;
  key: string;
  /** `null` means the attribute was removed. */
  value: string | null;
  /** Index into `regions`, or `null` for every region. */
  region: number | null;
}

interface OnDemandRow {
  at: number;
  region: number;
  variant: number;
  /** USD per hour; `null` means no longer offered. */
  hourly: number | null;
}

interface ReservedRow {
  at: number;
  region: number;
  variant: number;
  term: number;
  /** USD per hour; `null` means no longer offered. */
  hourly: number | null;
  upfront: number | null;
}

export interface DecodedInstance {
  name: string;
  platform: string;
  createdAt: number;
  deletedAt: number | null;
  regions: Region[];
  variantKeys: string[];
  /** Each variant's values, in `variantKeys` order. */
  variants: string[][];
  terms: ReservedTerm[];
  /** Oldest first, starting with the attributes the instance was first listed with. */
  attributes: AttributeChange[];
  /** Oldest first. */
  onDemand: OnDemandRow[];
  /** Oldest first. */
  reserved: ReservedRow[];
}

function stringTable(file: InstanceFile) {
  const strings = file.compression_table;
  return (i: number | null | undefined): string => {
    const s = i === null || i === undefined ? undefined : strings[i];
    if (s === undefined) throw new Error(`string index ${i} out of range`);
    return s;
  };
}

/**
 * Every attribute change, oldest first, starting with the attributes the
 * instance was first listed with. `region` maps a location's string index to
 * the caller's region numbering; without it, regional changes are left out.
 */
export function decodeAttributes(
  file: InstanceFile,
  str = stringTable(file),
  region?: (loc: number) => number,
): AttributeChange[] {
  const [attrs, changes, , , , createdAt] = file.instance;
  const out: AttributeChange[] = attrs.map(([k, v]) => ({
    at: createdAt,
    key: str(k),
    value: str(v),
    region: null,
  }));
  const rows: AttributeChange[] = [];
  for (const [ts, key, value, loc] of changes) {
    const regional = loc !== null && loc !== undefined;
    if (regional && !region) continue;
    rows.push({
      at: ts!,
      key: str(key),
      value: value === null || value === undefined ? null : str(value),
      region: regional ? region!(loc) : null,
    });
  }
  // Stable, so rows with the same timestamp keep their order (later rows win).
  return out.concat(rows.sort((a, b) => a.at - b.at));
}

export function decodeInstance(file: InstanceFile): DecodedInstance {
  const str = stringTable(file);

  // Rows refer to locations by string index. The regions table only lists
  // locations AWS gave attributes (a code, a type), so any other location a row
  // names is added, by name alone, the first time it comes up.
  const regionIndex = new Map<number, number>();
  const regions: Region[] = [];
  for (const [loc, pairs] of file.regions) {
    const attrs = Object.fromEntries(pairs.map(([k, v]) => [str(k), str(v)]));
    const region: Region = { name: str(loc) };
    if (attrs.regionCode) region.code = attrs.regionCode;
    if (attrs.locationType) region.type = attrs.locationType;
    regionIndex.set(loc, regions.push(region) - 1);
  }
  const region = (loc: number | null | undefined): number => {
    let i = loc === null || loc === undefined ? undefined : regionIndex.get(loc);
    if (i === undefined) {
      i = regions.push({ name: str(loc) }) - 1;
      regionIndex.set(loc!, i);
    }
    return i;
  };

  const [, , basePrice, od, rs, createdAt, deletedAt] = file.instance;
  const byTime = (a: { at: number }, b: { at: number }) => a.at - b.at;

  return {
    name: file.name,
    platform: file.platform,
    createdAt,
    deletedAt: deletedAt ?? null,
    regions,
    variantKeys: file.variant_keys ?? EC2_VARIANT_KEYS,
    variants: file.variants.map((fields) => fields.map(str)),
    terms: file.reserved_terms.map(([lease, offeringClass, purchaseOption]) => ({
      lease: str(lease),
      offeringClass: str(offeringClass),
      purchaseOption: str(purchaseOption),
    })),
    attributes: decodeAttributes(file, str, region),
    // [ts, region, variant, price: omitted = base price, null = no longer offered]
    // AWS sometimes lists an instance at $0 on demand while it has no capacity
    // to sell (p4d.24xlarge in us-east-1, on and off since 2024). Nothing is
    // free on demand, so $0 reads as not offered. Reserved rows are left alone:
    // an all-upfront term is legitimately $0 an hour.
    onDemand: od
      .map(([ts, loc, variant, ...price]) => {
        const hourly = price.length === 0 ? basePrice : (price[0] ?? null);
        return {
          at: ts!,
          region: region(loc),
          variant: variant!,
          hourly: hourly === 0 ? null : hourly,
        };
      })
      .sort(byTime),
    // [ts, region, variant, term, hourly: null = no longer offered, upfront: omitted if 0]
    reserved: rs
      .map(([ts, loc, variant, term, hourly, upfront]) => {
        const removed = hourly === null || hourly === undefined;
        return {
          at: ts!,
          region: region(loc),
          variant: variant!,
          term: term!,
          hourly: removed ? null : hourly,
          upfront: removed ? null : (upfront ?? 0),
        };
      })
      .sort(byTime),
  };
}
