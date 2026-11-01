import type { InstanceValue } from "../../format";

/** The parts of a fixture bundle (`bundles.ts`) that `expandBundle` reads. */
interface FixtureBundle<Name extends string> {
  compression_table: string[];
  variants: number[][];
  reserved_terms: number[][];
  regions: unknown[];
  instances: Record<Name, unknown[]>;
}

/** Every index in a value resolved back to its string, for comparing two encodings. */
function expand(
  strings: string[],
  variants: number[][],
  terms: number[][],
  regions: unknown[],
  row: unknown[],
) {
  const s = (i: unknown) => {
    const value = strings[i as number];
    if (value === undefined) throw new Error(`no string ${String(i)}`);
    return value;
  };
  const [attrs, changes, base, od, rs, created, deleted] = row as [
    number[][],
    unknown[][],
    number,
    unknown[][],
    unknown[][],
    number,
    number | null,
  ];
  const used = new Set<string>();
  const result = {
    attrs: attrs.map(([k, v]) => [s(k), s(v)]),
    changes: changes.map((c) => {
      if (c.length > 3) used.add(s(c[3]));
      return [c[0], s(c[1]), c[2] === null ? null : s(c[2]), c.length > 3 ? s(c[3]) : ""];
    }),
    base,
    od: od.map((r) => {
      used.add(s(r[1]));
      return [r[0], s(r[1]), variants[r[2] as number]!.map(s), ...r.slice(3)];
    }),
    rs: rs.map((r) => {
      used.add(s(r[1]));
      const v = variants[r[2] as number]!.map(s);
      return [r[0], s(r[1]), v, terms[r[3] as number]!.map(s), ...r.slice(4)];
    }),
    created,
    deleted,
    regions: [] as unknown[],
  };
  for (const [loc, pairs] of regions as [number, number[][]][]) {
    if (used.has(s(loc))) result.regions.push([s(loc), pairs.map(([k, v]) => [s(k), s(v)])]);
  }
  return result;
}

export function expandBundle<Name extends string>(bundle: FixtureBundle<Name>, name: Name) {
  return expand(
    bundle.compression_table,
    bundle.variants,
    bundle.reserved_terms,
    bundle.regions,
    bundle.instances[name],
  );
}

export function expandValue(value: InstanceValue) {
  return expand(
    value.compression_table,
    value.variants,
    value.reserved_terms,
    value.regions,
    value.instance,
  );
}
