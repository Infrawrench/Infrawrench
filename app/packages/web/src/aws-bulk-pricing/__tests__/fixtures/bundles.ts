/**
 * Small bundles in the instances-bundler's format. Each `<name>.json.xz` next
 * to this file is `JSON.stringify(<fixture>) + "\n"` (what the bundler's Go
 * encoder writes) through `xz -9 -T0`, as the publisher compresses them; the
 * tests check the two still agree. To regenerate after changing one:
 *
 *   node --experimental-strip-types -e 'import("./bundles.ts").then(m =>
 *     process.stdout.write(JSON.stringify(m.RDS_BUNDLE) + "\n"))' | xz -9 -T0 > rds-bundle.json.xz
 */

/** An RDS bundle: two instances, one of them deleted, and a string nothing uses. */
export const RDS_BUNDLE = {
  offer: "AmazonRDS",
  compression_table: [
    "US East (N. Virginia)", // 0
    "EU (Ireland)", // 1
    "regionCode", // 2
    "us-east-1", // 3
    "eu-west-1", // 4
    "MySQL", // 5
    "PostgreSQL", // 6
    "Single-AZ", // 7
    "InstanceUsage", // 8
    "vcpu", // 9
    "2", // 10
    "4", // 11
    "memory", // 12
    "8 GiB", // 13
    "16 GiB", // 14
    "1yr", // 15
    "No Upfront", // 16
    "standard", // 17
    "Asia Pacific (Tokyo)", // 18, a region neither instance is priced in
    "ap-northeast-1", // 19
  ],
  snapshots: [1790000000, 1791000000],
  regions: [
    [18, [[2, 19]]],
    [1, [[2, 4]]],
    [0, [[2, 3]]],
  ],
  variant_keys: ["databaseEngine", "deploymentOption", "usagetype"],
  variants: [
    [5, 7, 8],
    [6, 7, 8],
  ],
  reserved_terms: [[15, 16, 17]],
  instances: {
    "db.m5.large": [
      [
        [9, 10],
        [12, 13],
      ],
      [
        [1791000000, 12, 14],
        [1791000000, 9, null, 1],
      ],
      0.171,
      [
        [1790000000, 0, 0],
        [1790000000, 0, 1, 0.2],
        [1791000000, 1, 0, 0.19],
        [1791000000, 0, 1, null],
      ],
      [[1790000000, 0, 0, 0, 0.1, 500]],
      1790000000,
      null,
    ],
    'db.t2."odd"': [[[9, 11]], [], 0.5, [[1790000000, 1, 1]], [], 1790000000, 1791000000],
  },
};

/** An EC2 bundle, which (like the real ones) has no `offer` or `variant_keys`. */
export const EC2_BUNDLE = {
  compression_table: [
    "US East (N. Virginia)",
    "Linux",
    "Shared",
    "No License required",
    "NA",
    "Used",
    "vcpu",
    "2",
  ],
  snapshots: [1790000000],
  regions: [[0, []]],
  variants: [[1, 2, 3, 4, 5]],
  reserved_terms: [],
  instances: {
    "m5.large": [[[6, 7]], [], 0.096, [[1790000000, 0, 0]], [], 1790000000, null],
  },
};

/**
 * An EC2 spot bundle, as the bundler writes one from AWS's spot price feed:
 * its own offer code, `operatingSystem` as the only variant key, no attributes,
 * and region codes for locations, each with its code and type.
 */
export const SPOT_BUNDLE = {
  offer: "AmazonEC2Spot",
  compression_table: [
    "us-east-1", // 0
    "us-east-1-atl-1", // 1
    "locationType", // 2
    "regionCode", // 3
    "AWS Local Zone", // 4
    "AWS Region", // 5
    "Linux", // 6
    "Windows", // 7
  ],
  snapshots: [1792022400],
  regions: [
    [
      0,
      [
        [2, 5],
        [3, 0],
      ],
    ],
    [
      1,
      [
        [2, 4],
        [3, 1],
      ],
    ],
  ],
  variant_keys: ["operatingSystem"],
  variants: [[6], [7]],
  reserved_terms: [],
  instances: {
    "m5.large": [
      [],
      [],
      0.0405,
      [
        [1792022400, 0, 0],
        [1792022400, 0, 1, 0.1312],
        [1792022400, 1, 0, 0.0512],
      ],
      [],
      1792022400,
      null,
    ],
    "t4g.nano": [[], [], 0.0013, [[1792022400, 0, 0]], [], 1792022400, null],
  },
};

/** A RunPod bundle (the bulk-instances SDKs' conformance fixture): a GPU type and a retired CPU pod, priced in `global`, with savings plans. */
export const RUNPOD_BUNDLE = {
  offer: "RunpodPods",
  compression_table: [
    "global",
    "US-TX-1",
    "Secure Cloud",
    "Community Cloud",
    "location",
    "United States",
    "locationType",
    "Data Center",
    "regionCode",
    "Global",
    "3mo",
    "Savings Plan",
    "All Upfront",
    "6mo",
    "dataCenters",
    "displayName",
    "H100 SXM",
    "memoryInGb",
    "80",
    "priceUnit",
    "GPU-Hour",
    "productFamily",
    "GPU",
    "EU-RO-1,US-TX-1",
    "4",
    "Hour",
    "CPU",
    "vcpu",
    "2",
  ],
  snapshots: [1700000000, 1710000000, 1720000000],
  regions: [
    [
      1,
      [
        [4, 5],
        [6, 7],
        [8, 1],
      ],
    ],
    [
      0,
      [
        [6, 9],
        [8, 0],
      ],
    ],
  ],
  variant_keys: ["cloudType"],
  variants: [[2], [3]],
  reserved_terms: [
    [10, 11, 12],
    [13, 11, 12],
  ],
  instances: {
    "NVIDIA H100 80GB HBM3": [
      [
        [14, 1],
        [15, 16],
        [17, 18],
        [19, 20],
        [21, 22],
      ],
      [[1710000000, 14, 23]],
      2.69,
      [
        [1700000000, 0, 1],
        [1700000000, 0, 0, 3.99],
        [1710000000, 0, 0, 2.99],
        [1720000000, 0, 1, null],
      ],
      [
        [1700000000, 0, 0, 0, 3.49],
        [1700000000, 0, 0, 1, 3.29],
        [1710000000, 0, 0, 0, 2.89],
      ],
      1700000000,
      null,
    ],
    "cpu3c-2-4": [
      [
        [17, 24],
        [19, 25],
        [21, 26],
        [27, 28],
      ],
      [],
      0.06,
      [
        [1700000000, 0, 0],
        [1720000000, 0, 0, null],
      ],
      [],
      1700000000,
      1720000000,
    ],
  },
};

/** An Alibaba Cloud ECS bundle (the same source): subscriptions, reserved instances, and the `source_version` AWS bundles lack. */
export const ALIBABA_BUNDLE = {
  offer: "AlibabaECS",
  source_version: "2.0.426",
  compression_table: [
    "cn-hangzhou",
    "us-east-1",
    "locationType",
    "Alibaba Cloud Region",
    "name",
    "China (Hangzhou)",
    "regionCode",
    "US (Virginia)",
    "Linux",
    "VPC",
    "Windows",
    "Classic",
    "1yr",
    "Subscription",
    "All Upfront",
    "1mo",
    "3yr",
    "Reserved Instance",
    "Partial Upfront",
    "CpuCoreCount",
    "2",
    "CpuOptions.ThreadsPerCore",
    "MemorySize",
    "8.0",
    "SupportedBootModes.SupportedBootMode",
    "BIOS,UEFI",
    "16.0",
  ],
  snapshots: [1700000000, 1710000000],
  regions: [
    [
      0,
      [
        [2, 3],
        [4, 5],
        [6, 0],
      ],
    ],
    [
      1,
      [
        [2, 3],
        [4, 7],
        [6, 1],
      ],
    ],
  ],
  variant_keys: ["operatingSystem", "networkType"],
  variants: [
    [8, 9],
    [10, 9],
    [8, 11],
  ],
  reserved_terms: [
    [12, 13, 14],
    [15, 13, 14],
    [16, 17, 18],
  ],
  instances: {
    "ecs.g6.large": [
      [
        [19, 20],
        [21, 20],
        [22, 23],
        [24, 25],
      ],
      [[1710000000, 22, 26]],
      0.1068,
      [
        [1700000000, 0, 0],
        [1700000000, 0, 2],
        [1700000000, 1, 0, 0.12],
        [1700000000, 1, 1, 0.2],
        [1710000000, 0, 2, null],
      ],
      [
        [1700000000, 0, 0, 0, 0, 500.5],
        [1700000000, 0, 0, 1, 0, 50],
        [1700000000, 0, 2, 0, 0, 480],
        [1700000000, 1, 1, 2, 0.05, 300],
        [1710000000, 1, 1, 2, 0.04, 250],
        [1710000000, 0, 2, 0, null],
      ],
      1700000000,
      null,
    ],
  },
};
