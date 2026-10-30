import { describe, expect, it } from "vitest";

import { scanBundle, type BundleEvent } from "../bundle-stream";
import { readTables, reduceInstance } from "../format";
import { EC2_BUNDLE, RDS_BUNDLE } from "./fixtures/bundles";
import { expandBundle, expandValue } from "./fixtures/expand";

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

async function* bytesOf(text: string, chunk: number): AsyncGenerator<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += chunk) yield bytes.slice(i, i + chunk);
}

describe("scanBundle", () => {
  const expected: BundleEvent[] = [
    ...Object.entries(RDS_BUNDLE)
      .filter(([key]) => key !== "instances")
      .map(([key, value]): BundleEvent => ({ kind: "table", key, value })),
    ...Object.entries(RDS_BUNDLE.instances).map(([name, value]): BundleEvent => ({
      kind: "instance",
      name,
      value,
    })),
  ];

  it.each([1, 3, 64, 1 << 20])("yields each table and instance, in %d-byte chunks", async (n) => {
    expect(await collect(scanBundle(bytesOf(JSON.stringify(RDS_BUNDLE) + "\n", n)))).toEqual(
      expected,
    );
  });

  it("allows whitespace anywhere JSON does", async () => {
    const pretty = JSON.stringify(RDS_BUNDLE, null, 2);
    expect(await collect(scanBundle(bytesOf(pretty, 5)))).toEqual(expected);
  });

  it("parses scalars and strings at the top level", async () => {
    const events = await collect(scanBundle(bytesOf('{"a":12,"b":"x\\"}","c":null}', 2)));
    expect(events).toEqual([
      { kind: "table", key: "a", value: 12 },
      { kind: "table", key: "b", value: 'x"}' },
      { kind: "table", key: "c", value: null },
    ]);
  });

  it("fails on a bundle cut short", async () => {
    const text = JSON.stringify(RDS_BUNDLE);
    await expect(collect(scanBundle(bytesOf(text.slice(0, -2), 16)))).rejects.toThrow(
      /ended before/,
    );
  });

  it("fails on something that is not an object", async () => {
    await expect(collect(scanBundle(bytesOf("[1,2]", 16)))).rejects.toThrow(/unexpected/);
  });
});

describe("reduceInstance", () => {
  const tables = readTables(RDS_BUNDLE, "rds");
  const reduce = (name: keyof typeof RDS_BUNDLE.instances) =>
    reduceInstance(tables, "rds", name, RDS_BUNDLE.instances[name]);

  it("says the same thing as the full bundle", () => {
    for (const name of Object.keys(RDS_BUNDLE.instances) as (keyof typeof RDS_BUNDLE.instances)[]) {
      expect(expandValue(reduce(name))).toEqual(expandBundle(RDS_BUNDLE, name));
    }
  });

  it("starts with a compression table of only the strings it uses, most used first", () => {
    const value = reduce("db.m5.large");
    expect(Object.keys(value)[0]).toBe("compression_table");
    // `US East` is the region of four rows and a region entry; Tokyo and
    // PostgreSQL's strings are nowhere in this instance.
    expect(value.compression_table[0]).toBe("US East (N. Virginia)");
    expect(value.compression_table).not.toContain("Asia Pacific (Tokyo)");
    expect(value.compression_table).not.toContain("ap-northeast-1");
    expect(new Set(value.compression_table).size).toBe(value.compression_table.length);
  });

  it("keeps only the regions, variants and terms it uses", () => {
    const value = reduce('db.t2."odd"');
    expect(value.regions).toHaveLength(1);
    expect(value.variants).toHaveLength(1);
    expect(value.reserved_terms).toEqual([]);
    expect(value.compression_table).not.toContain("MySQL");
    expect(value).toMatchObject({
      platform: "rds",
      offer: "AmazonRDS",
      name: 'db.t2."odd"',
      variant_keys: ["databaseEngine", "deploymentOption", "usagetype"],
    });
  });

  it("fills in EC2's offer and variant keys, which its bundles leave out", () => {
    const value = reduceInstance(
      readTables(EC2_BUNDLE, "ec2"),
      "ec2",
      "m5.large",
      EC2_BUNDLE.instances["m5.large"],
    );
    expect(value.offer).toBe("AmazonEC2");
    expect(value.variant_keys).toEqual([
      "operatingSystem",
      "tenancy",
      "licenseModel",
      "preInstalledSw",
      "capacitystatus",
    ]);
  });

  it("refuses an index the bundle does not have", () => {
    const row = structuredClone(RDS_BUNDLE.instances["db.m5.large"]);
    (row[3] as unknown[][])[0]![2] = 9;
    expect(() => reduceInstance(tables, "rds", "x", row)).toThrow(/variant 9/);
  });
});
