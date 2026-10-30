/**
 * AWS bulk pricing data: the format of what is kept in Workers KV.
 *
 * The instances-bundler (github.com/Infrawrench/instances-bundler) publishes one
 * bundle per AWS platform to the `instances-bundles` R2 bucket. A scheduled
 * GitHub Action (`scripts/sync-aws-bulk-pricing.ts`) splits each new bundle into
 * one KV value per instance, and `/api/v1/aws-bulk-pricing` serves them.
 *
 * An instance's value is its bundle cut down to that one instance, in the same
 * encoding, so the bulk-instances SDKs can read it with the code that reads a
 * bundle: its own `compression_table` first, holding only the strings this
 * instance uses (most used first), then the regions, variants and reserved
 * terms it refers to, renumbered to match, then the instance's row. KV holds it
 * gzipped.
 *
 * KV keys: `platform:<platform>` is what was last synced (a {@link PlatformState})
 * and `instance:<platform>:<name>` is one instance.
 */

/** Platform name (as in the bundler's `publish-<platform>.sh`) to AWS offer code. */
export const PLATFORMS: Readonly<Record<string, string>> = {
  ec2: "AmazonEC2",
  rds: "AmazonRDS",
  elasticache: "AmazonElastiCache",
  opensearch: "AmazonES",
  redshift: "AmazonRedshift",
  docdb: "AmazonDocDB",
  neptune: "AmazonNeptune",
  memorydb: "AmazonMemoryDB",
  dax: "AmazonDAX",
  sagemaker: "AmazonSageMaker",
  emr: "ElasticMapReduce",
  gamelift: "AmazonGameLift",
};

/** EC2 bundles predate `offer` and `variant_keys`, so they leave both out. */
const EC2_VARIANT_KEYS = [
  "operatingSystem",
  "tenancy",
  "licenseModel",
  "preInstalledSw",
  "capacitystatus",
];

/** Where a platform's bundles sit in the bucket. EC2's keys predate the rest and have no prefix. */
export function bucketPrefix(platform: string): string {
  return platform === "ec2" ? "" : `${platform}-`;
}

export const platformKey = (platform: string) => `platform:${platform}`;
export const instanceKey = (platform: string, name: string) => `instance:${platform}:${name}`;

/** What `platform:<platform>` holds. */
export interface PlatformState {
  platform: string;
  offer: string;
  variant_keys: string[];
  /** The bundle's version: what its `latest` held. */
  version: string;
  bundle: string;
  /** Unix seconds of every price list version the bundle was built from. */
  snapshots: number[];
  /** When the sync finished, in Unix milliseconds. */
  synced: number;
  /** Instance name to a hash of its value, so a sync rewrites only what changed. */
  instances: Record<string, string>;
}

export interface Tables {
  strings: string[];
  offer: string;
  variantKeys: string[];
  snapshots: number[];
  /** Location's string index to its `[location, [[key, value], ...]]` entry. */
  regions: Map<number, [number, [number, number][]]>;
  variants: number[][];
  terms: number[][];
}

export function readTables(raw: Record<string, unknown>, platform: string): Tables {
  const strings = raw["compression_table"];
  if (!Array.isArray(strings) || !strings.every((s) => typeof s === "string")) {
    throw new Error("bundle has no compression_table");
  }
  const regions = new Map<number, [number, [number, number][]]>();
  for (const entry of arrayOf(raw["regions"], "regions")) {
    const [loc, pairs] = arrayOf(entry, "regions");
    regions.set(int(loc), [int(loc), arrayOf(pairs, "regions").map(pair)]);
  }
  const indexLists = (key: string) =>
    arrayOf(raw[key], key).map((row) => arrayOf(row, key).map(int));
  const variantKeys = raw["variant_keys"] ?? (platform === "ec2" ? EC2_VARIANT_KEYS : undefined);
  if (!Array.isArray(variantKeys) || !variantKeys.every((s) => typeof s === "string")) {
    throw new Error("bundle has no variant_keys");
  }
  const offer = raw["offer"] ?? PLATFORMS[platform];
  if (typeof offer !== "string") throw new Error("bundle has no offer");
  return {
    strings: strings as string[],
    offer,
    variantKeys: variantKeys as string[],
    snapshots: arrayOf(raw["snapshots"] ?? [], "snapshots").map(int),
    regions,
    variants: indexLists("variants"),
    terms: indexLists("reserved_terms"),
  };
}

/** The value stored for one instance. */
export interface InstanceValue {
  compression_table: string[];
  platform: string;
  offer: string;
  name: string;
  variant_keys: string[];
  regions: [number, [number, number][]][];
  variants: number[][];
  reserved_terms: number[][];
  /** `[attrs, attrChanges, basePrice, onDemand, reserved, createdAt, deletedAt]`, as in a bundle. */
  instance: unknown[];
}

/**
 * Cut the bundle down to one instance, renumbering every string, variant and
 * reserved term it uses. Indices are handed out most used first (ties in bundle
 * order), the way the bundler orders its own tables, so common ones stay short.
 */
export function reduceInstance(
  t: Tables,
  platform: string,
  name: string,
  row: unknown,
): InstanceValue {
  const [attrs, changes, basePrice, od, rs, createdAt, deletedAt] = arrayOf(row, name);
  if (createdAt === undefined) throw new Error(`instance ${name} has too few fields`);

  const strings = new Counter();
  const variants = new Counter();
  const terms = new Counter();
  const locations = new Set<number>();

  const attrPairs = arrayOf(attrs, name).map(pair);
  for (const [k, v] of attrPairs) strings.add(k, v);

  const changeRows = arrayOf(changes, name).map((c) => arrayOf(c, name));
  for (const c of changeRows) {
    strings.add(int(c[1]));
    if (c[2] !== null) strings.add(int(c[2]));
    if (c.length > 3) {
      strings.add(int(c[3]));
      locations.add(int(c[3]));
    }
  }
  const odRows = arrayOf(od, name).map((r) => arrayOf(r, name));
  for (const r of odRows) {
    strings.add(int(r[1]));
    locations.add(int(r[1]));
    variants.add(int(r[2]));
  }
  const rsRows = arrayOf(rs, name).map((r) => arrayOf(r, name));
  for (const r of rsRows) {
    strings.add(int(r[1]));
    locations.add(int(r[1]));
    variants.add(int(r[2]));
    terms.add(int(r[3]));
  }
  for (const v of variants.keys()) strings.add(...lookup(t.variants, v, "variant"));
  for (const term of terms.keys()) strings.add(...lookup(t.terms, term, "reserved term"));
  // In the bundle's order, which sorts them by location.
  const regions = [...t.regions.values()].filter(([loc]) => locations.has(loc));
  for (const [, pairs] of regions) for (const [k, v] of pairs) strings.add(k, v);

  const S = strings.renumber();
  const V = variants.renumber();
  const T = terms.renumber();
  const s = (i: unknown) => S.get(int(i))!;

  return {
    compression_table: strings.order().map((i) => lookup(t.strings, i, "string")),
    platform,
    offer: t.offer,
    name,
    variant_keys: t.variantKeys,
    regions: regions.map(([loc, pairs]) => [s(loc), pairs.map(([k, v]) => [s(k), s(v)])]),
    variants: variants.order().map((v) => lookup(t.variants, v, "variant").map(s)),
    reserved_terms: terms.order().map((term) => lookup(t.terms, term, "reserved term").map(s)),
    instance: [
      attrPairs.map(([k, v]) => [s(k), s(v)]),
      changeRows.map((c) => [
        c[0],
        s(c[1]),
        c[2] === null ? null : s(c[2]),
        ...(c.length > 3 ? [s(c[3])] : []),
      ]),
      basePrice,
      odRows.map((r) => [r[0], s(r[1]), V.get(int(r[2]))!, ...r.slice(3)]),
      rsRows.map((r) => [r[0], s(r[1]), V.get(int(r[2]))!, T.get(int(r[3]))!, ...r.slice(4)]),
      createdAt,
      deletedAt ?? null,
    ],
  };
}

/** Counts uses of old indices and hands out new ones, most used first. */
class Counter {
  private readonly counts = new Map<number, number>();

  add(...indices: number[]): void {
    for (const i of indices) this.counts.set(i, (this.counts.get(i) ?? 0) + 1);
  }

  keys(): IterableIterator<number> {
    return this.counts.keys();
  }

  /** Old indices in their new order. */
  order(): number[] {
    return [...this.counts.keys()].sort(
      (a, b) => this.counts.get(b)! - this.counts.get(a)! || a - b,
    );
  }

  /** Old index to new index. */
  renumber(): Map<number, number> {
    return new Map(this.order().map((old, i) => [old, i]));
  }
}

function lookup<T>(list: T[], i: number, what: string): T {
  const value = list[i];
  if (value === undefined) throw new Error(`bundle refers to ${what} ${i}, which it does not have`);
  return value;
}

function arrayOf(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`bundle's ${what} is not a list`);
  return value;
}

function int(value: unknown): number {
  if (!Number.isInteger(value)) throw new Error(`bundle has ${JSON.stringify(value)} for an index`);
  return value as number;
}

function pair(value: unknown): [number, number] {
  const [a, b] = arrayOf(value, "pair");
  return [int(a), int(b)];
}
