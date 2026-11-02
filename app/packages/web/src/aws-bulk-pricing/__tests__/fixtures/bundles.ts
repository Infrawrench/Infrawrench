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

/**
 * An Azure bundle (the bulk-instances SDKs' conformance fixture): VM sizes by
 * ARM name, ARM region names with an English `name`, `operatingSystem` and
 * `priority` as variant keys, All Upfront reservations and No Upfront savings
 * plans, one size withdrawn from its reservation and one without calculator
 * specs.
 */
export const AZURE_BUNDLE = {
  offer: "AzureVM",
  compression_table: [
    "eastus",
    "westeurope",
    "locationType",
    "Azure Region",
    "name",
    "US East",
    "regionCode",
    "EU West",
    "Linux",
    "Regular",
    "Windows",
    "Spot",
    "Low Priority",
    "1yr",
    "Reserved Instance",
    "All Upfront",
    "Savings Plan",
    "No Upfront",
    "3yr",
    "cores",
    "2",
    "diskSize",
    "16",
    "isVcpu",
    "true",
    "productFamily",
    "Virtual Machines",
    "productName",
    "Virtual Machines DSv3 Series",
    "ram",
    "8.0",
    "series",
    "Dsv3",
    "skuName",
    "D2s v3",
    "D2pds v7",
    "Virtual Machines Dpdsv7 Series",
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
  variant_keys: ["operatingSystem", "priority"],
  variants: [
    [8, 9],
    [10, 9],
    [8, 11],
    [10, 12],
  ],
  reserved_terms: [
    [13, 14, 15],
    [13, 16, 17],
    [18, 16, 17],
  ],
  instances: {
    Standard_D2s_v3: [
      [
        [19, 20],
        [21, 22],
        [23, 24],
        [25, 26],
        [27, 28],
        [29, 30],
        [31, 32],
        [33, 34],
      ],
      [],
      0.096,
      [
        [1668464000, 0, 0],
        [1668464000, 0, 1, 0.188],
        [1700000000, 0, 2, 0.01919],
        [1700000000, 0, 3, 0.075],
        [1700000000, 1, 0, 0.12],
        [1710000000, 0, 2, 0.0215],
      ],
      [
        [1700000000, 0, 0, 0, 0, 500],
        [1700000000, 0, 0, 1, 0.06624],
        [1700000000, 0, 0, 2, 0.04512],
        [1710000000, 0, 0, 0, null],
      ],
      1700000000,
      null,
    ],
    Standard_D2pds_v7: [
      [
        [25, 26],
        [33, 35],
      ],
      [[1710000000, 27, 36, 0]],
      0.08,
      [[1710000000, 0, 0]],
      [],
      1710000000,
      null,
    ],
  },
};

/**
 * A Google Cloud bundle (the bulk-instances SDKs' conformance fixture):
 * machine types with Compute Engine API attributes, `zones` that differ by
 * region, Standard and Spot, committed use discounts, and a deleted GPU type.
 */
export const GCP_BUNDLE = {
  offer: "GCPCompute",
  compression_table: [
    "us-central1",
    "europe-west1",
    "locationType",
    "Google Cloud Region",
    "regionCode",
    "Standard",
    "Spot",
    "1yr",
    "Committed Use",
    "No Upfront",
    "3yr",
    "description",
    "2 vCPUs 8 GB RAM",
    "guestCpus",
    "2",
    "isSharedCpu",
    "false",
    "memoryMb",
    "8192",
    "productFamily",
    "Compute Engine",
    "zones",
    "us-central1-a,us-central1-b",
    "europe-west1-b,europe-west1-c",
    "us-central1-a",
    "acceleratorCount",
    "1",
    "acceleratorType",
    "nvidia-tesla-a100",
    "12",
    "87040",
  ],
  snapshots: [1700000000, 1710000000, 1720000000],
  regions: [
    [
      1,
      [
        [2, 3],
        [4, 1],
      ],
    ],
    [
      0,
      [
        [2, 3],
        [4, 0],
      ],
    ],
  ],
  variant_keys: ["provisioningModel"],
  variants: [[5], [6]],
  reserved_terms: [
    [7, 8, 9],
    [10, 8, 9],
  ],
  instances: {
    "n2-standard-2": [
      [
        [11, 12],
        [13, 14],
        [15, 16],
        [17, 18],
        [19, 20],
        [21, 22],
      ],
      [
        [1700000000, 21, 23, 1],
        [1720000000, 21, 24, 0],
      ],
      0.097118,
      [
        [1700000000, 0, 0],
        [1700000000, 0, 1, 0.058256],
        [1700000000, 1, 0, 0.106836],
        [1710000000, 0, 1, 0.0571],
      ],
      [
        [1700000000, 0, 0, 0, 0.061182],
        [1700000000, 0, 0, 1, 0.043706],
      ],
      1700000000,
      null,
    ],
    "a2-highgpu-1g": [
      [
        [25, 26],
        [27, 28],
        [13, 29],
        [17, 30],
        [19, 20],
        [21, 24],
      ],
      [],
      3.673385,
      [
        [1700000000, 0, 0],
        [1700000000, 0, 1, 1.98913],
        [1720000000, 0, 0, null],
        [1720000000, 0, 1, null],
      ],
      [
        [1700000000, 0, 0, 0, 2.31420704],
        [1720000000, 0, 0, 0, null],
      ],
      1700000000,
      1720000000,
    ],
  },
};
