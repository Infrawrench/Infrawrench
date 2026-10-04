/**
 * CoreWeave instance types, zones and published list prices.
 *
 * CoreWeave has no pricing API, so this table is the only source of a rate.
 * Specs come from the instance pages (https://docs.coreweave.com/platform/instances/gpu-instances
 * and /cpu-instances), the instance ids are the `instanceType` values a Node
 * Pool takes and the `SkuId` the FOCUS usage export reports, and the prices
 * are the North America on-demand rates on https://www.coreweave.com/pricing,
 * all read on {@link PRICING_AS_OF}. Instances CoreWeave lists as "Contact
 * sales" carry no price: they are reported as usage with no money attached
 * rather than with an invented number. Reserved, Spot and Flex rates are not
 * published at all; the account's "Negotiated rates" field is where a
 * contract price goes.
 */

export const PRICING_AS_OF = "2026-10-04";

export interface InstanceSpec {
  /** Node Pool `instanceType` and FOCUS `SkuId`. */
  id: string;
  name: string;
  family: "gpu" | "cpu";
  /** GPU model, e.g. "NVIDIA H100". Absent for CPU instances. */
  gpuModel?: string;
  gpuCount: number;
  /** Memory per GPU, GB. */
  gpuMemoryGb: number;
  cpuModel: string;
  vcpus: number;
  ramGb: number;
  storageTb: number;
  /** On-demand USD per instance-hour, or `null` when CoreWeave does not publish one. */
  hourlyUsd: number | null;
  /**
   * NVL72 rack-scale instances: Node Pools of these are sized in whole racks
   * of 18 Nodes and cannot autoscale.
   */
  rackScale?: boolean;
  /** Availability Zones CoreWeave lists the instance in. */
  zones: string[];
}

export const NODES_PER_RACK = 18;

export const INSTANCE_TYPES: InstanceSpec[] = [
  {
    id: "verarubin-4x-e",
    name: "Vera Rubin NVL72 (Spectrum-X RoCE)",
    family: "gpu",
    gpuModel: "NVIDIA Vera Rubin",
    gpuCount: 4,
    gpuMemoryGb: 288,
    cpuModel: "NVIDIA Vera",
    vcpus: 352,
    ramGb: 1536,
    storageTb: 30.72,
    hourlyUsd: null,
    rackScale: true,
    zones: ["US-CENTRAL-09A"],
  },
  {
    id: "gb300-4x",
    name: "GB300 NVL72 (Quantum-X InfiniBand)",
    family: "gpu",
    gpuModel: "NVIDIA GB300",
    gpuCount: 4,
    gpuMemoryGb: 279,
    cpuModel: "NVIDIA Grace",
    vcpus: 144,
    ramGb: 960,
    storageTb: 30.72,
    hourlyUsd: null,
    rackScale: true,
    zones: ["CA-EAST-01A", "US-CENTRAL-07A", "US-CENTRAL-09A", "US-WEST-01A"],
  },
  {
    id: "gb300-4x-e",
    name: "GB300 NVL72 (Spectrum-X RoCE)",
    family: "gpu",
    gpuModel: "NVIDIA GB300",
    gpuCount: 4,
    gpuMemoryGb: 279,
    cpuModel: "NVIDIA Grace",
    vcpus: 144,
    ramGb: 960,
    storageTb: 30.72,
    hourlyUsd: null,
    rackScale: true,
    zones: [],
  },
  {
    id: "gb200-4x",
    name: "GB200 NVL72",
    family: "gpu",
    gpuModel: "NVIDIA GB200",
    gpuCount: 4,
    gpuMemoryGb: 186,
    cpuModel: "NVIDIA Grace",
    vcpus: 144,
    ramGb: 960,
    storageTb: 15.36,
    hourlyUsd: 42.0,
    rackScale: true,
    zones: [
      "CA-EAST-01A",
      "US-EAST-01A",
      "US-EAST-02A",
      "US-EAST-08A",
      "US-EAST-13A",
      "US-WEST-01A",
    ],
  },
  {
    id: "b300-8x",
    name: "HGX B300 (InfiniBand)",
    family: "gpu",
    gpuModel: "NVIDIA B300",
    gpuCount: 8,
    gpuMemoryGb: 270,
    cpuModel: "Intel Xeon",
    vcpus: 192,
    ramGb: 4096,
    storageTb: 30.72,
    hourlyUsd: null,
    zones: ["US-CENTRAL-06A", "US-EAST-13A", "US-WEST-01A", "US-WEST-10A"],
  },
  {
    id: "b200-8x",
    name: "HGX B200 (InfiniBand)",
    family: "gpu",
    gpuModel: "NVIDIA B200",
    gpuCount: 8,
    gpuMemoryGb: 180,
    cpuModel: "Intel Xeon",
    vcpus: 128,
    ramGb: 2048,
    storageTb: 30.72,
    hourlyUsd: 68.8,
    zones: ["EU-SOUTH-04A", "US-CENTRAL-07A", "US-EAST-13A", "US-EAST-15A", "US-WEST-09B"],
  },
  {
    id: "gd-8xh200ib-i128",
    name: "HGX H200 (InfiniBand)",
    family: "gpu",
    gpuModel: "NVIDIA H200",
    gpuCount: 8,
    gpuMemoryGb: 141,
    cpuModel: "Intel Xeon",
    vcpus: 128,
    ramGb: 2048,
    storageTb: 30.72,
    hourlyUsd: 50.44,
    zones: [
      "EU-SOUTH-03B",
      "US-EAST-01A",
      "US-EAST-02A",
      "US-EAST-04A",
      "US-EAST-08A",
      "US-WEST-04A",
    ],
  },
  {
    id: "gd-8xh100ib-i128",
    name: "HGX H100 (InfiniBand)",
    family: "gpu",
    gpuModel: "NVIDIA H100",
    gpuCount: 8,
    gpuMemoryGb: 80,
    cpuModel: "Intel Xeon",
    vcpus: 128,
    ramGb: 2048,
    storageTb: 30.72,
    hourlyUsd: 49.24,
    zones: [
      "RNO2A",
      "US-CENTRAL-06A",
      "US-EAST-01A",
      "US-EAST-02A",
      "US-EAST-04A",
      "US-EAST-06A",
      "US-WEST-01A",
      "US-WEST-02B",
      "US-WEST-04A",
      "US-WEST-09B",
    ],
  },
  {
    id: "rtxp6000-8x",
    name: "RTX PRO 6000 Blackwell Server Edition (High Memory)",
    family: "gpu",
    gpuModel: "NVIDIA RTX PRO 6000 Blackwell",
    gpuCount: 8,
    gpuMemoryGb: 96,
    cpuModel: "AMD EPYC",
    vcpus: 128,
    ramGb: 1024,
    storageTb: 7.68,
    hourlyUsd: 20.0,
    zones: [
      "EU-SOUTH-04A",
      "US-EAST-01A",
      "US-EAST-04A",
      "US-EAST-06A",
      "US-EAST-13A",
      "US-EAST-14A",
      "US-WEST-01A",
      "US-WEST-04A",
      "US-WEST-09B",
      "US-WEST-10A",
    ],
  },
  {
    id: "rtxp6000-8x-v2",
    name: "RTX PRO 6000 Blackwell Server Edition (Standard Memory)",
    family: "gpu",
    gpuModel: "NVIDIA RTX PRO 6000 Blackwell",
    gpuCount: 8,
    gpuMemoryGb: 96,
    cpuModel: "AMD EPYC",
    vcpus: 128,
    ramGb: 512,
    storageTb: 7.68,
    hourlyUsd: null,
    zones: ["US-EAST-15A"],
  },
  {
    id: "gd-8xl40s-i128",
    name: "L40S",
    family: "gpu",
    gpuModel: "NVIDIA L40S",
    gpuCount: 8,
    gpuMemoryGb: 48,
    cpuModel: "Intel Xeon",
    vcpus: 128,
    ramGb: 1024,
    storageTb: 7.68,
    hourlyUsd: 18.0,
    zones: ["US-EAST-04A"],
  },
  {
    id: "gd-8xl40-i128",
    name: "L40",
    family: "gpu",
    gpuModel: "NVIDIA L40",
    gpuCount: 8,
    gpuMemoryGb: 48,
    cpuModel: "Intel Xeon",
    vcpus: 128,
    ramGb: 1024,
    storageTb: 7.68,
    hourlyUsd: 10.0,
    zones: ["RNO2A", "US-EAST-02A", "US-EAST-04A"],
  },
  {
    id: "gd-1xgh200",
    name: "GH200",
    family: "gpu",
    gpuModel: "NVIDIA GH200",
    gpuCount: 1,
    gpuMemoryGb: 96,
    cpuModel: "NVIDIA Grace",
    vcpus: 72,
    ramGb: 480,
    storageTb: 7.68,
    hourlyUsd: 6.5,
    zones: ["RNO2A", "US-EAST-04A"],
  },
  {
    id: "gd-8xa100-i128",
    name: "HGX A100",
    family: "gpu",
    gpuModel: "NVIDIA A100",
    gpuCount: 8,
    gpuMemoryGb: 80,
    cpuModel: "Intel Xeon",
    vcpus: 128,
    ramGb: 2048,
    storageTb: 7.68,
    hourlyUsd: 21.6,
    zones: ["RNO2A", "US-EAST-04A"],
  },
  {
    id: "cd-hp-a96-genoa",
    name: "High Performance AMD Genoa",
    family: "cpu",
    gpuCount: 0,
    gpuMemoryGb: 0,
    cpuModel: "AMD Genoa 9274F",
    vcpus: 96,
    ramGb: 768,
    storageTb: 7.68,
    hourlyUsd: 6.42,
    zones: ["US-EAST-04A"],
  },
  {
    id: "cd-gp-a192-genoa",
    name: "General Purpose AMD Genoa",
    family: "cpu",
    gpuCount: 0,
    gpuMemoryGb: 0,
    cpuModel: "AMD Genoa 9454",
    vcpus: 192,
    ramGb: 1536,
    storageTb: 7.68,
    hourlyUsd: 7.78,
    zones: ["RNO2A", "US-EAST-02A", "US-EAST-06A", "US-WEST-01A", "US-WEST-04A"],
  },
  {
    id: "cd-gp-l-a192-genoa",
    name: "General Purpose AMD Genoa (High Storage)",
    family: "cpu",
    gpuCount: 0,
    gpuMemoryGb: 0,
    cpuModel: "AMD Genoa 9454",
    vcpus: 192,
    ramGb: 1536,
    storageTb: 30.72,
    hourlyUsd: 8.86,
    zones: ["US-EAST-08A"],
  },
  {
    id: "cd-hc-a384-genoa",
    name: "High Core AMD Genoa",
    family: "cpu",
    gpuCount: 0,
    gpuMemoryGb: 0,
    cpuModel: "AMD Genoa 9654",
    vcpus: 384,
    ramGb: 1536,
    storageTb: 30.72,
    hourlyUsd: 7.54,
    zones: ["US-EAST-04A"],
  },
  {
    id: "cd-hc-a384ib-genoa",
    name: "High Core AMD Genoa (InfiniBand)",
    family: "cpu",
    gpuCount: 0,
    gpuMemoryGb: 0,
    cpuModel: "AMD Genoa 9654",
    vcpus: 384,
    ramGb: 1536,
    storageTb: 7.68,
    hourlyUsd: null,
    zones: ["US-EAST-04A"],
  },
  {
    id: "turin-gp",
    name: "General Purpose AMD Turin (High Memory)",
    family: "cpu",
    gpuCount: 0,
    gpuMemoryGb: 0,
    cpuModel: "AMD Turin 9655P",
    vcpus: 192,
    ramGb: 1536,
    storageTb: 7.68,
    hourlyUsd: 8.18,
    zones: [
      "CA-EAST-01A",
      "EU-SOUTH-03B",
      "EU-SOUTH-04A",
      "RNO2A",
      "US-CENTRAL-06A",
      "US-CENTRAL-07A",
      "US-CENTRAL-09A",
      "US-EAST-01A",
      "US-EAST-02A",
      "US-EAST-04A",
      "US-EAST-06A",
      "US-EAST-13A",
      "US-EAST-14A",
      "US-EAST-15A",
      "US-WEST-09B",
      "US-WEST-10A",
    ],
  },
  {
    id: "turin-gp-l",
    name: "General Purpose AMD Turin (High Storage)",
    family: "cpu",
    gpuCount: 0,
    gpuMemoryGb: 0,
    cpuModel: "AMD Turin 9655P",
    vcpus: 192,
    ramGb: 1536,
    storageTb: 30.72,
    hourlyUsd: 9.31,
    zones: ["RNO2A", "US-CENTRAL-09A", "US-EAST-02A", "US-EAST-04A", "US-EAST-15A", "US-EAST-17A"],
  },
  {
    id: "turin-gp-v2",
    name: "General Purpose AMD Turin (Standard Memory)",
    family: "cpu",
    gpuCount: 0,
    gpuMemoryGb: 0,
    cpuModel: "AMD Turin 9655P",
    vcpus: 192,
    ramGb: 768,
    storageTb: 7.68,
    hourlyUsd: null,
    zones: [],
  },
  {
    id: "cd-gp-i64-erapids",
    name: "General Purpose Intel Emerald Rapids (High Memory)",
    family: "cpu",
    gpuCount: 0,
    gpuMemoryGb: 0,
    cpuModel: "Intel Emerald Rapids 8562Y+",
    vcpus: 64,
    ramGb: 512,
    storageTb: 7.68,
    hourlyUsd: 5.31,
    zones: [
      "CA-EAST-01A",
      "EU-SOUTH-03B",
      "EU-SOUTH-04A",
      "US-CENTRAL-06A",
      "US-CENTRAL-07A",
      "US-EAST-01A",
      "US-EAST-04A",
      "US-EAST-06A",
      "US-EAST-08A",
      "US-EAST-14A",
      "US-EAST-15A",
      "US-WEST-01A",
      "US-WEST-04A",
      "US-WEST-09B",
      "US-WEST-10A",
    ],
  },
  {
    id: "cd-gp-i64-erapids-v2",
    name: "General Purpose Intel Emerald Rapids (Standard Memory)",
    family: "cpu",
    gpuCount: 0,
    gpuMemoryGb: 0,
    cpuModel: "Intel Emerald Rapids 8562Y+",
    vcpus: 64,
    ramGb: 256,
    storageTb: 7.68,
    hourlyUsd: null,
    zones: [],
  },
  {
    id: "cd-gp-i96-icelake",
    name: "General Purpose Intel Ice Lake",
    family: "cpu",
    gpuCount: 0,
    gpuMemoryGb: 0,
    cpuModel: "Intel Ice Lake 6342",
    vcpus: 96,
    ramGb: 384,
    storageTb: 6.4,
    hourlyUsd: 3.36,
    zones: ["RNO2A"],
  },
];

const BY_ID = new Map(INSTANCE_TYPES.map((t) => [t.id, t]));

export function instanceSpec(id: string): InstanceSpec | undefined {
  return BY_ID.get(id);
}

export function isRackScale(instanceType: string): boolean {
  return instanceSpec(instanceType)?.rackScale === true;
}

/** Published non-compute list prices, same page and date as the instances. */
export const LIST_PRICES = {
  /** Distributed File Storage, USD per GB-month. */
  dfsGbMonth: 0.07,
  /** AI Object Storage hot tier, USD per GB-month (first tier of the usage-based model). */
  objectHotGbMonth: 0.06,
  objectWarmGbMonth: 0.03,
  objectColdGbMonth: 0.015,
  /** Public IP address, USD per month. */
  publicIpMonth: 4.0,
} as const;

/** Hours in the average month, the conversion CoreWeave's monthly prices imply. */
export const HOURS_PER_MONTH = 730;

/**
 * Availability Zones, from CoreWeave's region and instance availability pages
 * (2026-10). Used for pickers only: anything the API returns outside this list
 * is still displayed as-is.
 */
export const ZONES: string[] = [
  "CA-EAST-01A",
  "EU-NORTH-01A",
  "EU-NORTH-02A",
  "EU-NORTH-04A",
  "EU-NORTH-05A",
  "EU-SOUTH-01A",
  "EU-SOUTH-03B",
  "EU-SOUTH-04A",
  "EU-WEST-01A",
  "EU-WEST-02A",
  "RNO2A",
  "US-CENTRAL-01A",
  "US-CENTRAL-02A",
  "US-CENTRAL-03A",
  "US-CENTRAL-04A",
  "US-CENTRAL-05A",
  "US-CENTRAL-06A",
  "US-CENTRAL-07A",
  "US-CENTRAL-08A",
  "US-CENTRAL-08B",
  "US-CENTRAL-09A",
  "US-CENTRAL-10A",
  "US-CENTRAL-11A",
  "US-EAST-01A",
  "US-EAST-02A",
  "US-EAST-02B",
  "US-EAST-03A",
  "US-EAST-04A",
  "US-EAST-04B",
  "US-EAST-05A",
  "US-EAST-06A",
  "US-EAST-07A",
  "US-EAST-08A",
  "US-EAST-09A",
  "US-EAST-10A",
  "US-EAST-11A",
  "US-EAST-12A",
  "US-EAST-13A",
  "US-EAST-14A",
  "US-EAST-15A",
  "US-EAST-17A",
  "US-WEST-01A",
  "US-WEST-02A",
  "US-WEST-02B",
  "US-WEST-03A",
  "US-WEST-04A",
  "US-WEST-05A",
  "US-WEST-06A",
  "US-WEST-07A",
  "US-WEST-08A",
  "US-WEST-09B",
  "US-WEST-10A",
];

/**
 * Kubernetes versions CKS offers to new clusters ("CKS supports the three
 * latest versions", cluster components page, 2026-10). The create form merges
 * in any version an existing cluster already runs.
 */
export const KUBERNETES_VERSIONS = ["v1.37", "v1.36", "v1.35"];
