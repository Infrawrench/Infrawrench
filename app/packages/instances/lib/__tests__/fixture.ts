import type { InstanceFile } from "../decode";

/**
 * A small instance in the KV encoding: two regions with codes, plus a location
 * (`Local Zone X`) that only price rows name, three variants, two reserved
 * terms, a global attribute change and an Ireland-only one.
 */
const strings = [
  "US East (N. Virginia)", // 0
  "us-east-1",
  "AWS Region",
  "regionCode",
  "locationType",
  "EU (Ireland)", // 5
  "eu-west-1",
  "vcpu",
  "2",
  "memory",
  "8 GiB", // 10
  "Linux",
  "Shared",
  "Windows",
  "1yr",
  "standard", // 15
  "No Upfront",
  "3yr",
  "clockSpeed",
  "2.5 GHz",
  "3.1 GHz", // 20
  "Local Zone X",
  "storage",
  "EBS only",
  "Dedicated",
];

export const file: InstanceFile = {
  compression_table: strings,
  platform: "ec2",
  offer: "AmazonEC2",
  name: "m5.large",
  variant_keys: ["operatingSystem", "tenancy"],
  regions: [
    [
      0,
      [
        [3, 1],
        [4, 2],
      ],
    ],
    [
      5,
      [
        [3, 6],
        [4, 2],
      ],
    ],
  ],
  // Linux/Shared, Windows/Shared, Linux/Dedicated
  variants: [
    [11, 12],
    [13, 12],
    [11, 24],
  ],
  reserved_terms: [
    [14, 15, 16],
    [17, 15, 16],
  ],
  instance: [
    [
      [7, 8],
      [9, 10],
      [18, 19],
    ],
    [
      [3000, 22, 23, 5],
      [2000, 18, 20],
    ],
    0.1,
    [
      [1000, 0, 0],
      [1000, 0, 1, 0.2],
      [1000, 5, 0, 0.11],
      [2500, 0, 0, 0.09],
      [1500, 21, 0, 0.3],
      [4000, 21, 0, null],
      [1000, 0, 2, 0.15],
    ],
    [
      [1000, 0, 0, 0, 0.06],
      [1000, 0, 0, 1, 0.03, 500],
    ],
    1000,
    null,
  ],
};
