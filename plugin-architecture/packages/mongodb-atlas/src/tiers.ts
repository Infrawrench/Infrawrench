/**
 * Dedicated cluster tiers.
 *
 * The selectable tier names per cloud are the `instanceSize` enums of the
 * Admin API's `AWSHardwareSpec20240805` / `AzureHardwareSpec20240805` /
 * `GCPHardwareSpec20240805` schemas (github.com/mongodb/openapi, 2026-10).
 * They are only the fallback: the scale picker asks
 * `GET /groups/{groupId}/clusters/provider/regions` for the tiers actually
 * offered in the cluster's region and uses those when it can.
 *
 * vCPU and RAM come from MongoDB's AWS cluster configuration reference
 * (https://www.mongodb.com/docs/atlas/reference/amazon-aws/). Azure and Google
 * Cloud tiers of the same name are close but not identical, which is fine for
 * the one thing these numbers feed: the oversized-cluster finder's estimate
 * of how a smaller tier would cope, which is a ratio between two tiers of the
 * same cloud.
 */

export interface TierSpec {
  vcpus: number;
  memoryMb: number;
  /** Included storage in GB. */
  diskGb: number;
}

const GB = 1024;

export const TIER_SPECS: Record<string, TierSpec> = {
  M10: { vcpus: 2, memoryMb: 2 * GB, diskGb: 10 },
  M20: { vcpus: 2, memoryMb: 4 * GB, diskGb: 20 },
  M30: { vcpus: 2, memoryMb: 8 * GB, diskGb: 40 },
  M40: { vcpus: 4, memoryMb: 16 * GB, diskGb: 80 },
  M50: { vcpus: 8, memoryMb: 32 * GB, diskGb: 160 },
  M60: { vcpus: 16, memoryMb: 64 * GB, diskGb: 320 },
  M80: { vcpus: 32, memoryMb: 128 * GB, diskGb: 750 },
  M140: { vcpus: 48, memoryMb: 192 * GB, diskGb: 1000 },
  M200: { vcpus: 64, memoryMb: 256 * GB, diskGb: 1500 },
  M300: { vcpus: 96, memoryMb: 384 * GB, diskGb: 2000 },
  R40: { vcpus: 2, memoryMb: 16 * GB, diskGb: 80 },
  R50: { vcpus: 4, memoryMb: 32 * GB, diskGb: 160 },
  R60: { vcpus: 8, memoryMb: 64 * GB, diskGb: 320 },
  R80: { vcpus: 16, memoryMb: 128 * GB, diskGb: 750 },
  R200: { vcpus: 32, memoryMb: 256 * GB, diskGb: 1500 },
  R300: { vcpus: 48, memoryMb: 384 * GB, diskGb: 2000 },
  R400: { vcpus: 64, memoryMb: 512 * GB, diskGb: 3000 },
  R700: { vcpus: 96, memoryMb: 768 * GB, diskGb: 4000 },
  M40_NVME: { vcpus: 2, memoryMb: 16 * GB, diskGb: 380 },
  M50_NVME: { vcpus: 4, memoryMb: 32 * GB, diskGb: 760 },
  M60_NVME: { vcpus: 8, memoryMb: 64 * GB, diskGb: 1600 },
  M80_NVME: { vcpus: 16, memoryMb: 128 * GB, diskGb: 1600 },
  M200_NVME: { vcpus: 32, memoryMb: 256 * GB, diskGb: 3100 },
  M400_NVME: { vcpus: 64, memoryMb: 512 * GB, diskGb: 4000 },
};

/** Gen 2 tiers share the shape of their Gen 1 namesake. */
export function tierSpec(tier: string): TierSpec | undefined {
  return TIER_SPECS[tier] ?? TIER_SPECS[tier.replace(/_GEN_2$/, "")];
}

const AWS_TIERS = [
  "M10",
  "M20",
  "M30",
  "M40",
  "M50",
  "M60",
  "M80",
  "M100",
  "M140",
  "M200",
  "M300",
  "R40",
  "R50",
  "R60",
  "R80",
  "R200",
  "R300",
  "R400",
  "R700",
  "M40_NVME",
  "M50_NVME",
  "M60_NVME",
  "M80_NVME",
  "M200_NVME",
  "M400_NVME",
];
const AZURE_TIERS = [
  "M10",
  "M20",
  "M30",
  "M40",
  "M50",
  "M60",
  "M80",
  "M90",
  "M200",
  "R40",
  "R50",
  "R60",
  "R80",
  "R200",
  "R300",
  "R400",
  "M60_NVME",
  "M80_NVME",
  "M200_NVME",
  "M300_NVME",
  "M400_NVME",
  "M600_NVME",
];
const GCP_TIERS = [
  "M10",
  "M20",
  "M30",
  "M40",
  "M50",
  "M60",
  "M80",
  "M140",
  "M200",
  "M250",
  "M300",
  "M400",
  "R40",
  "R50",
  "R60",
  "R80",
  "R200",
  "R300",
  "R400",
  "R600",
];

export const TIERS_BY_PROVIDER: Record<string, string[]> = {
  AWS: AWS_TIERS,
  AZURE: AZURE_TIERS,
  GCP: GCP_TIERS,
};

/** Every dedicated tier name on any cloud, for the Edit form's enum. */
export const ALL_DEDICATED_TIERS: string[] = [
  ...new Set([...AWS_TIERS, ...AZURE_TIERS, ...GCP_TIERS]),
];

/** Shared and serverless sizes: not dedicated hardware, never rightsized or scaled here. */
export function isDedicatedTier(tier: string): boolean {
  return /^(M|R)\d/.test(tier) && !["M0", "M2", "M5"].includes(tier);
}

export function tierLabel(tier: string): string {
  const spec = tierSpec(tier);
  if (!spec) return tier;
  return `${tier} (${spec.vcpus} vCPU, ${Math.round(spec.memoryMb / GB)} GB RAM)`;
}
