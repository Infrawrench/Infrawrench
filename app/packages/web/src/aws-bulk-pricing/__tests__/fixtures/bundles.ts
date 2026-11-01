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
