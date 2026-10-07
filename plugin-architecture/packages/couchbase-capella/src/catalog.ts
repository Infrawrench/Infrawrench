import type { RegionOption, SelectOption } from "@infrawrench/plugin-base";

/**
 * Regions and node sizes for operational clusters, from Capella's provider
 * reference pages (docs.couchbase.com/cloud/reference/{aws,gcp,azure}.html,
 * 2026-10). The Management API has no listing for either.
 */
const AWS = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "ca-central-1",
  "sa-east-1",
  "mx-central-1",
  "eu-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-north-1",
  "eu-south-1",
  "eu-central-2",
  "il-central-1",
  "me-central-1",
  "me-south-1",
  "af-south-1",
  "ap-southeast-1",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-south-1",
  "ap-east-1",
  "ap-south-2",
  "ap-southeast-3",
  "ap-southeast-7",
  "ap-southeast-2",
  "ap-southeast-4",
];
const GCP = [
  "us-east1",
  "us-east4",
  "us-east5",
  "us-west1",
  "us-west2",
  "us-west3",
  "us-west4",
  "us-central1",
  "us-south1",
  "northamerica-northeast1",
  "northamerica-northeast2",
  "southamerica-east1",
  "southamerica-west1",
  "europe-west1",
  "europe-west2",
  "europe-west3",
  "europe-west4",
  "europe-west6",
  "europe-west8",
  "europe-west9",
  "europe-central2",
  "europe-north1",
  "europe-southwest1",
  "me-west1",
  "me-central2",
  "africa-south1",
  "asia-east1",
  "asia-east2",
  "asia-northeast1",
  "asia-northeast2",
  "asia-northeast3",
  "asia-south1",
  "asia-south2",
  "asia-southeast1",
  "asia-southeast2",
  "australia-southeast1",
  "australia-southeast2",
];
const AZURE = [
  "eastus",
  "eastus2",
  "centralus",
  "southcentralus",
  "canadacentral",
  "westus2",
  "westus3",
  "brazilsouth",
  "germanywestcentral",
  "norwayeast",
  "uksouth",
  "westeurope",
  "northeurope",
  "swedencentral",
  "switzerlandnorth",
  "uaenorth",
  "spaincentral",
  "francecentral",
  "australiaeast",
  "koreacentral",
  "centralindia",
  "eastasia",
  "southeastasia",
];

export const REGIONS: RegionOption[] = [
  ...AWS.map((r) => ({ id: r, label: r, location: "AWS", availableFor: ["aws"] })),
  ...GCP.map((r) => ({ id: r, label: r, location: "Google Cloud", availableFor: ["gcp"] })),
  ...AZURE.map((r) => ({ id: r, label: r, location: "Azure", availableFor: ["azure"] })),
];

const SIZES: Record<string, Array<[number, number]>> = {
  aws: [
    [2, 8],
    [4, 16],
    [4, 32],
    [8, 16],
    [8, 32],
    [8, 64],
    [16, 32],
    [16, 64],
    [16, 128],
    [32, 64],
    [32, 128],
    [32, 256],
    [48, 96],
    [48, 192],
    [48, 384],
    [64, 128],
    [64, 256],
    [64, 512],
  ],
  gcp: [
    [2, 8],
    [4, 16],
    [4, 32],
    [8, 16],
    [8, 32],
    [8, 64],
    [16, 32],
    [16, 64],
    [16, 128],
    [32, 128],
    [32, 256],
    [36, 72],
    [48, 96],
    [48, 192],
    [48, 384],
    [64, 256],
    [64, 512],
    [72, 144],
  ],
  azure: [
    [2, 8],
    [4, 16],
    [4, 32],
    [8, 16],
    [8, 32],
    [8, 64],
    [16, 32],
    [16, 64],
    [16, 128],
    [20, 160],
    [32, 64],
    [32, 128],
    [32, 256],
    [48, 96],
    [48, 192],
    [48, 384],
    [64, 128],
    [64, 256],
    [64, 512],
    [72, 144],
  ],
};

export function computeOptions(cloud?: string): SelectOption[] {
  const all = new Map<string, string[]>();
  for (const [provider, sizes] of Object.entries(SIZES)) {
    if (cloud && provider !== cloud) continue;
    for (const [cpu, ram] of sizes) {
      const id = `${cpu}/${ram}`;
      all.set(id, [...(all.get(id) ?? []), provider.toUpperCase()]);
    }
  }
  return Array.from(all.entries())
    .sort((a, b) => {
      const [ac, ar] = a[0].split("/").map(Number) as [number, number];
      const [bc, br] = b[0].split("/").map(Number) as [number, number];
      return ac - bc || ar - br;
    })
    .map(([id, providers]) => {
      const [cpu, ram] = id.split("/");
      return {
        id,
        label: `${cpu} vCPU / ${ram} GB`,
        ...(cloud ? {} : { description: providers.join(", ") }),
      };
    });
}

export const COMPUTE_IDS = computeOptions().map((o) => o.id);

export function parseCompute(id: string): { cpu: number; ram: number } | null {
  const m = /^(\d+)\/(\d+)$/.exec(id.trim());
  return m ? { cpu: Number(m[1]), ram: Number(m[2]) } : null;
}

/** App Service node sizes (`AppServiceCompute` in the spec). */
export const APP_SERVICE_COMPUTE: SelectOption[] = [
  [2, 4],
  [4, 8],
  [8, 16],
  [16, 32],
  [36, 72],
].map(([cpu, ram]) => ({ id: `${cpu}/${ram}`, label: `${cpu} vCPU / ${ram} GB` }));

/** Default disk per cloud for a new service group. */
export function defaultDisk(cloud: string, storageGb: number): Record<string, unknown> {
  if (cloud === "gcp") return { type: "pd-ssd", storage: storageGb };
  if (cloud === "azure") return { type: "P10", autoExpansion: true };
  return { type: "gp3", storage: storageGb, iops: 3000 };
}

export const SERVICES = ["data", "query", "index", "search", "analytics", "eventing"];

export const ON_OFF_TIMEZONES = [
  "Pacific/Midway",
  "US/Hawaii",
  "US/Alaska",
  "US/Pacific",
  "US/Mountain",
  "US/Central",
  "US/Eastern",
  "America/Puerto_Rico",
  "Canada/Newfoundland",
  "America/Argentina/Buenos_Aires",
  "Atlantic/Cape_Verde",
  "Europe/London",
  "Europe/Amsterdam",
  "Europe/Athens",
  "Africa/Nairobi",
  "Asia/Tehran",
  "Indian/Mauritius",
  "Asia/Karachi",
  "Asia/Calcutta",
  "Asia/Dhaka",
  "Asia/Bangkok",
  "Asia/Hong_Kong",
  "Asia/Tokyo",
  "Australia/North",
  "Australia/Sydney",
  "Pacific/Ponape",
  "Antarctica/South_Pole",
];

export const ORG_ROLES = ["organizationOwner", "organizationMember", "projectCreator"];
export const PROJECT_ROLES = [
  "projectOwner",
  "projectManager",
  "projectViewer",
  "projectDataReaderWriter",
  "projectDataReader",
];

/** Billing categories, with readable names for the cost explorer's service dimension. */
export const BILLING_CATEGORIES: Record<string, string> = {
  operationalComputeAndStorage: "Operational compute and storage",
  operationalBucketBackup: "Operational bucket backup",
  operationalClusterBackup: "Operational cluster backup",
  analyticsCompute: "Analytics compute",
  analyticsStorage: "Analytics storage",
  analyticsClusterBackup: "Analytics cluster backup",
  appServicesComputeAndStorage: "App Services",
  dataTransferStandard: "Data transfer",
  privateEndpointsStandard: "Private endpoints",
  aiServicesLLM: "AI Services LLM",
  aiServicesAiGateway: "AI Services gateway",
  aiServicesUdsPager: "AI Services unstructured data",
  aiServicesSdsPager: "AI Services structured data",
  dataApiStandard: "Data API",
};
