import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PRICES, shardOf, shardsOf } from "@infrawrench/server-core/aws-pricing-warehouse/schema";

import { readTables, reduceInstance, type InstanceValue } from "../format";
import { syncAwsBulkPricing, syncPlatform, type BundleBucket, type PricingKv } from "../sync";
import {
  RowBinary,
  architectureOf,
  familyAndSize,
  instanceRows,
  isTransient,
  networkGbps,
  type PricingWarehouse,
  type WarehouseLoad,
} from "../warehouse";
import { RDS_BUNDLE } from "./fixtures/bundles";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

function reduced(name: keyof typeof RDS_BUNDLE.instances): InstanceValue {
  const tables = readTables(RDS_BUNDLE as unknown as Record<string, unknown>, "rds");
  return reduceInstance(tables, "rds", name, RDS_BUNDLE.instances[name]);
}

describe("instanceRows", () => {
  const rows = instanceRows(reduced("db.m5.large"), "rds");
  const prices = rows.prices.map((p) => ({
    region: p["region"],
    pricing: p["pricing"],
    engine: p["database_engine"],
    hourly: p["hourly_usd"],
    from: p["valid_from"],
    to: p["valid_to"],
    current: p["current"],
  }));

  it("turns price rows into periods, closing one at its next change or withdrawal", () => {
    expect(prices).toContainEqual({
      region: "us-east-1",
      pricing: "on_demand",
      engine: "PostgreSQL",
      hourly: 0.2,
      from: 1790000000,
      to: 1791000000,
      current: false,
    });
    // Omitted price is the base price.
    expect(prices).toContainEqual({
      region: "us-east-1",
      pricing: "on_demand",
      engine: "MySQL",
      hourly: 0.171,
      from: 1790000000,
      to: null,
      current: true,
    });
    expect(prices).toContainEqual(
      expect.objectContaining({
        region: "eu-west-1",
        engine: "MySQL",
        hourly: 0.19,
        current: true,
      }),
    );
  });

  it("spreads a reserved term's upfront payment over its hours", () => {
    const reserved = rows.prices.find((p) => p["pricing"] === "reserved")!;
    // (The fixture's term lists its class and option the other way round from
    // real bundles, so only the lease is checked here.)
    expect(reserved).toMatchObject({
      lease: "1yr",
      hourly_usd: 0.1,
      upfront_usd: 500,
      current: true,
    });
    expect(reserved["effective_hourly_usd"]).toBeCloseTo(0.1 + 500 / 8760, 10);
  });

  it("takes specs from the latest global attributes and keeps the history", () => {
    expect(rows.instanceType).toMatchObject({
      platform: "rds",
      instance_type: "db.m5.large",
      family: "m5",
      size: "large",
      vcpu: 2,
      memory_gib: 16,
      regions_offered: 2,
      retired_at: null,
    });
    expect(rows.attributeChanges).toContainEqual(
      expect.objectContaining({ attribute: "memory", value: "16 GiB", at: 1791000000, region: "" }),
    );
    // A regional change is history, not the current spec.
    expect(rows.attributeChanges).toContainEqual(
      expect.objectContaining({ attribute: "vcpu", value: null, region: "eu-west-1" }),
    );
    // Every price row repeats the specs.
    expect(rows.prices.every((p) => p["memory_gib"] === 16)).toBe(true);
  });

  it("closes a retired instance's prices when it was dropped", () => {
    const retired = instanceRows(reduced('db.t2."odd"'), "rds");
    expect(retired.instanceType).toMatchObject({ retired_at: 1791000000, regions_offered: 0 });
    expect(retired.prices.every((p) => p["valid_to"] === 1791000000 && !p["current"])).toBe(true);
  });

  it("reads a spot bundle's rows as ec2 spot prices with EC2's specs", () => {
    const value: InstanceValue = {
      compression_table: ["us-east-1", "Linux"],
      platform: "spot",
      offer: "AmazonEC2Spot",
      name: "m7g.large",
      variant_keys: ["operatingSystem"],
      regions: [],
      variants: [[1]],
      reserved_terms: [],
      instance: [
        [],
        [],
        0.03,
        [
          [1790000000, 0, 0],
          [1790003600, 0, 0, 0.031],
        ],
        [],
        1790000000,
        null,
      ],
    };
    const spot = instanceRows(value, "spot", {
      specFor: () => ({
        family: "m7g",
        size: "large",
        architecture: "arm64",
        vcpu: 2,
        memory_gib: 8,
        gpus: null,
      }),
    });
    expect(spot.instanceType).toBeNull();
    expect(spot.prices).toEqual([
      expect.objectContaining({
        platform: "ec2",
        pricing: "spot",
        operating_system: "Linux",
        hourly_usd: 0.03,
        valid_to: 1790003600,
        architecture: "arm64",
      }),
      expect.objectContaining({ hourly_usd: 0.031, current: true }),
    ]);
  });
});

describe("spec parsing", () => {
  it("names families and sizes across platforms", () => {
    expect(familyAndSize("db.r6g.xlarge")).toEqual({ family: "r6g", size: "xlarge" });
    expect(familyAndSize("r6g.large.search")).toEqual({ family: "r6g", size: "large" });
    expect(familyAndSize("ml.g5.12xlarge")).toEqual({ family: "g5", size: "12xlarge" });
    expect(familyAndSize("weird")).toEqual({ family: "", size: "" });
  });

  it("tells ARM from x86", () => {
    expect(architectureOf({ physicalProcessor: "AWS Graviton3 Processor" }, "m7g")).toBe("arm64");
    expect(architectureOf({ physicalProcessor: "Intel Xeon Platinum 8124M" }, "c5")).toBe("x86_64");
    expect(architectureOf({ physicalProcessor: "AMD EPYC 9R14" }, "m7a")).toBe("x86_64");
    // No processor listed: AWS's `g` after the generation means Graviton.
    expect(architectureOf({}, "r7g")).toBe("arm64");
    expect(architectureOf({}, "x2gd")).toBe("arm64");
    expect(architectureOf({}, "g5")).toBe("");
    expect(architectureOf({ processorArchitecture: "64-bit" }, "g5")).toBe("x86_64");
  });

  it("reads network performance as Gbit/s", () => {
    expect(networkGbps("Up to 12500 Megabit")).toBe(12.5);
    expect(networkGbps("25 Gigabit")).toBe(25);
    expect(networkGbps("Moderate")).toBeNull();
  });
});

describe("RowBinary", () => {
  it("encodes strings with a varint length, nullables with a flag, maps as pairs", () => {
    const w = new RowBinary();
    w.row(
      [
        { name: "s", type: "String", comment: "" },
        { name: "n", type: "Nullable(Float64)", comment: "" },
        { name: "t", type: "DateTime", comment: "" },
        { name: "m", type: "Map(String, String)", comment: "" },
        { name: "b", type: "Bool", comment: "" },
      ],
      { s: "é", n: null, t: 1, m: { a: "b" }, b: true },
    );
    expect([...w.bytes()]).toEqual([2, 0xc3, 0xa9, 1, 1, 0, 0, 0, 1, 1, 0x61, 1, 0x62, 1]);
  });

  it("writes a long string's length in more than one byte", () => {
    const w = new RowBinary();
    w.row([{ name: "s", type: "String", comment: "" }], { s: "x".repeat(200) });
    expect([...w.bytes().subarray(0, 3)]).toEqual([0xc8, 0x01, 0x78]);
    expect(w.length).toBe(202);
  });

  it("encodes every column of a price row", () => {
    const w = new RowBinary();
    const [row] = instanceRows(reduced("db.m5.large"), "rds").prices;
    w.row(PRICES.columns, row!);
    expect(w.rows).toBe(1);
    expect(w.length).toBeGreaterThan(100);
  });
});

it("treats Cloudflare's error pages as worth retrying, and ClickHouse exceptions as not", () => {
  expect(isTransient(500, "<!DOCTYPE html><title>Worker threw exception</title>")).toBe(true);
  expect(isTransient(500, "error code: 1101")).toBe(true);
  expect(isTransient(503, "")).toBe(true);
  expect(isTransient(500, "Code: 62. DB::Exception: Syntax error")).toBe(false);
});

// ---------------------------------------------------------------------------
// The sync's use of the warehouse

function bucket(objects: Record<string, Uint8Array | string>): BundleBucket {
  return {
    async text(key) {
      const value = objects[key];
      if (value === undefined) return null;
      return typeof value === "string" ? value : new TextDecoder().decode(value);
    },
    stream(key) {
      const value = objects[key];
      return new ReadableStream({
        start(controller) {
          if (value === undefined) return controller.error(new Error(`no ${key}`));
          controller.enqueue(typeof value === "string" ? new TextEncoder().encode(value) : value);
          controller.close();
        },
      });
    },
  };
}

const RDS_ONLY = {
  "rds-latest": "1791000000\n",
  "rds-bundle-1791000000.json.xz": fixture("rds-bundle.json.xz"),
};

function memoryKv(): PricingKv & { puts: string[] } {
  const store = new Map<string, Uint8Array>();
  const puts: string[] = [];
  return {
    puts,
    async getJson<T>(key: string) {
      const v = store.get(key);
      return v ? (JSON.parse(new TextDecoder().decode(v)) as T) : null;
    },
    async putMany(pairs) {
      for (const p of pairs) {
        puts.push(p.key);
        store.set(p.key, p.value);
      }
    },
    async deleteMany(keys) {
      for (const k of keys) store.delete(k);
    },
  };
}

function fakeWarehouse(
  versions: Record<string, string> = {},
  fail = false,
): PricingWarehouse & { loaded: { source: string; instances: string[]; version?: string }[] } {
  const loaded: { source: string; instances: string[]; version?: string }[] = [];
  return {
    loaded,
    async versions() {
      return new Map(Object.entries(versions));
    },
    async begin(source): Promise<WarehouseLoad> {
      if (fail) throw new Error("warehouse down");
      const entry: { source: string; instances: string[]; version?: string } = {
        source,
        instances: [],
      };
      loaded.push(entry);
      return {
        async add(value) {
          entry.instances.push(value.name);
        },
        async commit({ version }) {
          entry.version = version;
          return { priceRows: entry.instances.length };
        },
      };
    },
  };
}

describe("sync with a warehouse", () => {
  it("loads a bundle the warehouse lacks even when KV already has it, without rewriting KV", async () => {
    const kv = memoryKv();
    await syncPlatform("rds", bucket(RDS_ONLY), kv, null);
    const previous = await kv.getJson<never>("platform:rds");
    kv.puts.length = 0;
    const warehouse = fakeWarehouse();
    const result = await syncPlatform("rds", bucket(RDS_ONLY), kv, previous, {
      warehouse,
      version: null,
    });
    expect(result).toMatchObject({ platform: "rds", written: 0, warehouseRows: 2 });
    expect(kv.puts).toEqual([]);
    expect(warehouse.loaded).toEqual([
      { source: "rds", instances: ["db.m5.large", 'db.t2."odd"'], version: "1791000000" },
    ]);
  });

  it("skips a bundle both already have", async () => {
    const kv = memoryKv();
    await syncPlatform("rds", bucket(RDS_ONLY), kv, null);
    const previous = await kv.getJson<never>("platform:rds");
    const result = await syncPlatform("rds", bucket(RDS_ONLY), kv, previous, {
      warehouse: fakeWarehouse(),
      version: "1791000000",
    });
    expect(result).toBeNull();
  });

  it("still writes KV when the warehouse fails, then fails the run", async () => {
    const kv = memoryKv();
    await expect(
      syncAwsBulkPricing(bucket(RDS_ONLY), kv, () => {}, fakeWarehouse({}, true)),
    ).rejects.toThrow(/failed to sync/);
    expect(kv.puts).toContain("platform:rds");
  });
});

describe("shards", () => {
  it("splits only the largest sources, deterministically", () => {
    expect(shardsOf("rds")).toEqual(["rds"]);
    expect(shardOf("rds", "db.m5.large")).toBe("rds");
    expect(shardsOf("ec2")).toHaveLength(16);
    expect(shardsOf("ec2")).toContain(shardOf("ec2", "m7g.large"));
    expect(shardOf("ec2", "m7g.large")).toBe(shardOf("ec2", "m7g.large"));
  });

  it("spreads EC2's instance types over every shard", () => {
    const names = Array.from({ length: 800 }, (_, i) => `t${i}.large`);
    expect(new Set(names.map((n) => shardOf("ec2", n))).size).toBe(16);
  });
});
