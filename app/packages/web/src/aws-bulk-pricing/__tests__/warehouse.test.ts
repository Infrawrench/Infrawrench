import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PRICES, shardOf, shardsOf } from "@infrawrench/server-core/aws-pricing-warehouse/schema";

import { readTables, reduceInstance, type InstanceValue } from "../format";
import { syncAwsBulkPricing, syncPlatform, type BundleBucket, type PricingKv } from "../sync";
import { ClickHouseHttp } from "../warehouse";
import {
  RowBinary,
  architectureOf,
  familyAndSize,
  instanceRows,
  isTransient,
  leaseHours,
  networkGbps,
  specsOf,
  type PricingWarehouse,
  type WarehouseLoad,
} from "../warehouse";
import {
  ALIBABA_BUNDLE,
  AZURE_BUNDLE,
  GCP_BUNDLE,
  RDS_BUNDLE,
  RUNPOD_BUNDLE,
} from "./fixtures/bundles";

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

function reducedFrom(
  bundle: { instances: Record<string, unknown> },
  platform: string,
  name: string,
) {
  const tables = readTables(bundle as unknown as Record<string, unknown>, platform);
  return reduceInstance(tables, platform, name, bundle.instances[name]);
}

describe("other clouds", () => {
  it("reads specs under Hetzner's, OVHcloud's, Oracle's and IBM's keys", () => {
    expect(
      specsOf(
        "cax11",
        { cores: "2", memoryInGb: "4", architecture: "arm64", cpu: "Ampere" },
        "hetzner",
      ),
    ).toMatchObject({ family: "cax", vcpu: 2, memory_gib: 4, architecture: "arm64" });
    expect(
      specsOf("3107671", { "CPU.Name": "Intel Core i7-7700", "RAM.Size": "64" }, "hetznerauction"),
    ).toMatchObject({ vcpu: null, memory_gib: 64, architecture: "x86_64" });
    expect(
      specsOf("t1-45", { "cpu.cores": "8", "memory.size": "45", "gpu.number": "1" }, "ovh"),
    ).toMatchObject({ vcpu: 8, memory_gib: 45, gpus: 1, architecture: "x86_64" });
    // Memory is a choice in each price's variant.
    expect(
      specsOf("24sys01", { "cpu.threads": "12", "cpu.number": "1", range: "soyoustart" }, "ovheco"),
    ).toMatchObject({ family: "24sys", vcpu: 12, memory_gib: null });
    // An OCPU is two vCPUs, or one on A1; an A10 is a GPU, not an Arm CPU.
    expect(
      specsOf("VM.Standard.E5.Flex-2-16", { ocpus: "2", memoryInGb: "16" }, "oracle"),
    ).toMatchObject({ vcpu: 4, memory_gib: 16, architecture: "x86_64" });
    expect(
      specsOf("VM.Standard.A1.Flex-4-24", { ocpus: "4", memoryInGb: "24" }, "oracle"),
    ).toMatchObject({ vcpu: 4, architecture: "arm64" });
    expect(
      specsOf("VM.GPU.A10.1", { ocpus: "15", memoryInGb: "240", gpuCount: "1" }, "oracle"),
    ).toMatchObject({ vcpu: 30, gpus: 1, architecture: "x86_64" });
    expect(
      specsOf(
        "gx3-16x80x1l4",
        { cpu: "16", ram: "80", gpu_count: "1", vcpu_architecture: "amd64" },
        "ibm",
      ),
    ).toMatchObject({ family: "gx3", vcpu: 16, memory_gib: 80, gpus: 1, architecture: "x86_64" });
  });

  it("prices a monthly rental from its term, with no on-demand rows", () => {
    const table = [
      "gra",
      "regionCode",
      "ram-32g",
      "1mo",
      "Rental",
      "All Upfront",
      "OVHcloud Data Center",
      "locationType",
      "range",
      "soyoustart",
      "Gravelines",
      "name",
    ];
    const rows = instanceRows(
      {
        compression_table: table,
        platform: "ovheco",
        offer: "OVHEco",
        name: "24sys01",
        variant_keys: ["memory"],
        regions: [
          [
            0,
            [
              [1, 0],
              [7, 6],
              [11, 10],
            ],
          ],
        ],
        variants: [[2]],
        reserved_terms: [[3, 4, 5]],
        instance: [[[8, 9]], [], 0, [], [[1700000000, 0, 0, 0, 0, 73]], 1700000000, null],
      },
      "ovheco",
    );
    expect(rows.instanceType).toMatchObject({ family: "24sys", category: "soyoustart" });
    const [rent] = rows.prices;
    expect(rows.prices).toHaveLength(1);
    expect(rent).toMatchObject({
      pricing: "reserved",
      lease: "1mo",
      offering_class: "Rental",
      hourly_usd: 0,
      upfront_usd: 73,
      effective_hourly_usd: 0.1,
      current: true,
    });
  });

  it("reads a RunPod GPU type as one GPU, priced per GPU, in `global`", () => {
    const rows = instanceRows(
      reducedFrom(RUNPOD_BUNDLE, "runpod", "NVIDIA H100 80GB HBM3"),
      "runpod",
    );
    expect(rows.instanceType).toMatchObject({
      platform: "runpod",
      family: "",
      size: "",
      vcpu: null,
      memory_gib: null,
      gpus: 1,
      gpu_memory_gib: 80,
      gpu_model: "H100 SXM",
      category: "GPU",
      regions_offered: 1,
    });
    const current = rows.prices.filter((p) => p["current"]);
    expect(current).toContainEqual(
      expect.objectContaining({
        region: "global",
        pricing: "on_demand",
        variant: { cloudType: "Secure Cloud" },
        hourly_usd: 2.99,
      }),
    );
    // Community Cloud stopped selling it.
    expect(
      current.some(
        (p) => (p["variant"] as Record<string, string>)["cloudType"] === "Community Cloud",
      ),
    ).toBe(false);
    // A savings plan's hourly is already its effective rate.
    expect(current).toContainEqual(
      expect.objectContaining({
        pricing: "reserved",
        lease: "3mo",
        offering_class: "Savings Plan",
        hourly_usd: 2.89,
        effective_hourly_usd: 2.89,
      }),
    );
    expect(rows.regions.get("global")).toEqual(["global", "Global"]);
  });

  it("reads a RunPod CPU pod's flavor, vCPUs and memory from its id and attributes", () => {
    const rows = instanceRows(reducedFrom(RUNPOD_BUNDLE, "runpod", "cpu3c-2-4"), "runpod");
    expect(rows.instanceType).toMatchObject({
      family: "cpu3c",
      size: "2-4",
      vcpu: 2,
      memory_gib: 4,
      gpus: null,
      gpu_memory_gib: null,
      retired_at: 1720000000,
    });
  });

  it("reads Alibaba ECS specs, region names and subscriptions", () => {
    const rows = instanceRows(reducedFrom(ALIBABA_BUNDLE, "alibaba", "ecs.g6.large"), "alibaba");
    expect(rows.instanceType).toMatchObject({
      platform: "alibaba",
      family: "g6",
      size: "large",
      // Alibaba's g6 is not Graviton-style ARM.
      architecture: "",
      vcpu: 2,
      memory_gib: 16,
    });
    expect(rows.regions.get("cn-hangzhou")).toEqual(["China (Hangzhou)", "Alibaba Cloud Region"]);
    const subscription = (lease: string) =>
      rows.prices.find(
        (p) =>
          p["current"] &&
          p["offering_class"] === "Subscription" &&
          p["lease"] === lease &&
          p["region"] === "cn-hangzhou" &&
          p["operating_system"] === "Linux",
      )!;
    expect(subscription("1yr")).toMatchObject({ hourly_usd: 0, upfront_usd: 500.5 });
    expect(subscription("1yr")["effective_hourly_usd"]).toBeCloseTo(500.5 / 8760, 10);
    expect(subscription("1mo")["effective_hourly_usd"]).toBeCloseTo(50 / 730, 10);
    expect(rows.prices).toContainEqual(
      expect.objectContaining({ operating_system: "Linux", variant: { networkType: "VPC" } }),
    );
  });

  it("reads Azure specs, region names, spot priority, reservations and savings plans", () => {
    const rows = instanceRows(reducedFrom(AZURE_BUNDLE, "azure", "Standard_D2s_v3"), "azure");
    expect(rows.instanceType).toMatchObject({
      platform: "azure",
      family: "Dsv3",
      size: "2",
      architecture: "x86_64",
      vcpu: 2,
      memory_gib: 8,
      storage: "16 GiB temporary disk",
      category: "General purpose",
    });
    expect(rows.regions.get("eastus")).toEqual(["US East", "Azure Region"]);
    const current = rows.prices.filter((p) => p["current"] && p["region"] === "eastus");
    expect(current).toContainEqual(
      expect.objectContaining({
        pricing: "on_demand",
        operating_system: "Linux",
        variant: { priority: "Spot" },
        hourly_usd: 0.0215,
      }),
    );
    expect(current).toContainEqual(
      expect.objectContaining({
        pricing: "reserved",
        offering_class: "Savings Plan",
        lease: "1yr",
        purchase_option: "No Upfront",
        hourly_usd: 0.06624,
        effective_hourly_usd: 0.06624,
      }),
    );
    // The 1-year reservation was withdrawn.
    expect(
      current.some((p) => p["offering_class"] === "Reserved Instance" && p["lease"] === "1yr"),
    ).toBe(false);
    const withdrawn = rows.prices.find((p) => p["offering_class"] === "Reserved Instance")!;
    expect(withdrawn).toMatchObject({ hourly_usd: 0, upfront_usd: 500 });
    expect(withdrawn["effective_hourly_usd"]).toBeCloseTo(500 / 8760, 10);
  });

  it("reads an Azure size without calculator specs from its name", () => {
    const rows = instanceRows(reducedFrom(AZURE_BUNDLE, "azure", "Standard_D2pds_v7"), "azure");
    expect(rows.instanceType).toMatchObject({
      family: "Dpdsv7",
      size: "2",
      architecture: "arm64",
      vcpu: null,
      memory_gib: null,
    });
  });

  it("reads Google Cloud machine types, GPUs, region names and committed use", () => {
    const rows = instanceRows(reducedFrom(GCP_BUNDLE, "gcp", "a2-highgpu-1g"), "gcp");
    expect(rows.instanceType).toMatchObject({
      platform: "gcp",
      family: "a2",
      size: "highgpu-1g",
      architecture: "x86_64",
      vcpu: 12,
      memory_gib: 85,
      gpus: 1,
      gpu_model: "nvidia-tesla-a100",
      category: "Accelerator-optimized",
      retired_at: 1720000000,
    });
    expect(rows.regions.get("us-central1")).toEqual([
      "Council Bluffs, Iowa",
      "Google Cloud Region",
    ]);
    const standard = instanceRows(reducedFrom(GCP_BUNDLE, "gcp", "n2-standard-2"), "gcp");
    expect(standard.instanceType).toMatchObject({ family: "n2", size: "standard-2", vcpu: 2 });
    expect(standard.prices).toContainEqual(
      expect.objectContaining({
        current: true,
        region: "us-central1",
        pricing: "reserved",
        offering_class: "Committed Use",
        lease: "3yr",
        hourly_usd: 0.043706,
      }),
    );
    expect(standard.prices).toContainEqual(
      expect.objectContaining({
        current: true,
        pricing: "on_demand",
        variant: { provisioningModel: "Spot" },
      }),
    );
    // `zones` differs by region, so each region's value is an attribute change of its own.
    expect(standard.attributeChanges).toContainEqual(
      expect.objectContaining({ attribute: "zones", region: "us-central1" }),
    );
  });

  it("spreads upfront over months as well as years", () => {
    expect(leaseHours("1mo")).toBe(730);
    expect(leaseHours("6mo")).toBe(4380);
    expect(leaseHours("1yr")).toBe(8760);
    expect(leaseHours("5yr")).toBe(5 * 8760);
  });

  it("reads Alibaba's architecture from CpuArchitecture", () => {
    expect(
      specsOf(
        "ecs.g8y.large",
        { CpuArchitecture: "ARM", CpuCoreCount: "2", MemorySize: "8.0" },
        "alibaba",
      ),
    ).toMatchObject({
      architecture: "arm64",
      vcpu: 2,
      memory_gib: 8,
    });
    expect(specsOf("ecs.g7.large", { CpuArchitecture: "X86" }, "alibaba").architecture).toBe(
      "x86_64",
    );
  });
});

describe("spec parsing", () => {
  it("names families and sizes across platforms", () => {
    expect(familyAndSize("db.r6g.xlarge")).toEqual({ family: "r6g", size: "xlarge" });
    expect(familyAndSize("r6g.large.search")).toEqual({ family: "r6g", size: "large" });
    expect(familyAndSize("ml.g5.12xlarge")).toEqual({ family: "g5", size: "12xlarge" });
    expect(familyAndSize("weird")).toEqual({ family: "", size: "" });
    expect(familyAndSize("ecs.g7.2xlarge")).toEqual({ family: "g7", size: "2xlarge" });
    expect(familyAndSize("cpu5m-16-128")).toEqual({ family: "cpu5m", size: "16-128" });
    expect(familyAndSize("NVIDIA H100 80GB HBM3")).toEqual({ family: "", size: "" });
    expect(familyAndSize("Standard_D2s_v3", "azure")).toEqual({ family: "Dsv3", size: "2" });
    expect(familyAndSize("Standard_E64-16as_v6", "azure")).toEqual({
      family: "Easv6",
      size: "64-16",
    });
    expect(familyAndSize("Standard_NC96ads_A100_v4", "azure")).toEqual({
      family: "NCads_A100_v4",
      size: "96",
    });
    expect(familyAndSize("Standard_B1ls", "azure")).toEqual({ family: "Bls", size: "1" });
    expect(familyAndSize("SPOT_Plus_Usage", "azure")).toEqual({ family: "", size: "" });
    expect(familyAndSize("c3-standard-4-lssd", "gcp")).toEqual({
      family: "c3",
      size: "standard-4-lssd",
    });
    expect(familyAndSize("e2-micro", "gcp")).toEqual({ family: "e2", size: "micro" });
    expect(familyAndSize("cx23", "hetzner")).toEqual({ family: "cx", size: "23" });
    expect(familyAndSize("3107671", "hetznerauction")).toEqual({ family: "", size: "" });
    expect(familyAndSize("t1-le-45", "ovh")).toEqual({ family: "t1-le", size: "45" });
    expect(familyAndSize("25sk60b", "ovheco")).toEqual({ family: "25sk", size: "60" });
    expect(familyAndSize("24skgame01-apac", "ovheco")).toEqual({ family: "24skgame", size: "01" });
    expect(familyAndSize("vx3d-22x352-spl", "ibm")).toEqual({ family: "vx3d", size: "22x352-spl" });
    expect(familyAndSize("VM.Standard.E5.Flex-2-16", "oracle")).toEqual({
      family: "VM.Standard.E5.Flex",
      size: "2-16",
    });
    expect(familyAndSize("BM.GPU.H100.8", "oracle")).toEqual({ family: "BM.GPU.H100", size: "8" });
    expect(familyAndSize("gx3-16x80x1l4", "ibm")).toEqual({ family: "gx3", size: "16x80x1l4" });
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

describe("deduplication of INSERTs", () => {
  const columns = [{ name: "k", type: "UInt64" }] as unknown as Parameters<
    ClickHouseHttp["insert"]
  >[1];

  it("sends the same token again when the answer was lost, so the batch lands once", async () => {
    const queries: (string | null)[] = [];
    const ch = new ClickHouseHttp({
      url: "https://warehouse.test/",
      token: "t",
      fetch: (async (url: URL) => {
        queries.push(url.searchParams.get("query"));
        if (queries.length === 1) throw new TypeError("connection lost after the commit");
        return new Response("");
      }) as unknown as typeof fetch,
    });
    await ch.insert("staging.prices", columns, new Uint8Array(1), "load-0");
    expect(queries).toEqual([
      "INSERT INTO staging.prices (k) SETTINGS insert_deduplication_token = 'load-0' FORMAT RowBinary",
      "INSERT INTO staging.prices (k) SETTINGS insert_deduplication_token = 'load-0' FORMAT RowBinary",
    ]);
  });

  it("sends no setting without a token", async () => {
    let query: string | null = null;
    const ch = new ClickHouseHttp({
      url: "https://warehouse.test/",
      token: "t",
      fetch: (async (url: URL) => {
        query = url.searchParams.get("query");
        return new Response("");
      }) as unknown as typeof fetch,
    });
    await ch.insert("t", columns, new Uint8Array(1));
    expect(query).toBe("INSERT INTO t (k) FORMAT RowBinary");
  });
});

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
