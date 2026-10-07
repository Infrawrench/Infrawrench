import type { RegionOption, SelectOption } from "@infrawrench/plugin-base";

/**
 * Regions Tiger Cloud runs services in (tigerdata.com/docs "Supported
 * regions", 2026-10). The API has no region listing. Azure codes carry an
 * `az-` prefix in the API (the Terraform provider documents `az-eastus2`,
 * and the status page names regions the same way).
 */
export const REGIONS: RegionOption[] = [
  { id: "us-east-1", label: "us-east-1", location: "North Virginia, USA", flag: "🇺🇸" },
  { id: "us-east-2", label: "us-east-2", location: "Ohio, USA", flag: "🇺🇸" },
  { id: "us-west-2", label: "us-west-2", location: "Oregon, USA", flag: "🇺🇸" },
  { id: "ca-central-1", label: "ca-central-1", location: "Central Canada", flag: "🇨🇦" },
  { id: "sa-east-1", label: "sa-east-1", location: "São Paulo, Brazil", flag: "🇧🇷" },
  { id: "eu-central-1", label: "eu-central-1", location: "Frankfurt, Germany", flag: "🇩🇪" },
  { id: "eu-central-2", label: "eu-central-2", location: "Zurich, Switzerland", flag: "🇨🇭" },
  { id: "eu-west-1", label: "eu-west-1", location: "Ireland", flag: "🇮🇪" },
  { id: "eu-west-2", label: "eu-west-2", location: "London, UK", flag: "🇬🇧" },
  { id: "ap-south-1", label: "ap-south-1", location: "Mumbai, India", flag: "🇮🇳" },
  { id: "ap-southeast-1", label: "ap-southeast-1", location: "Singapore", flag: "🇸🇬" },
  { id: "ap-southeast-2", label: "ap-southeast-2", location: "Sydney, Australia", flag: "🇦🇺" },
  { id: "ap-northeast-1", label: "ap-northeast-1", location: "Tokyo, Japan", flag: "🇯🇵" },
  { id: "az-eastus2", label: "az-eastus2", location: "Azure, Virginia, USA", flag: "🇺🇸" },
  { id: "az-westeurope", label: "az-westeurope", location: "Azure, Amsterdam", flag: "🇳🇱" },
  {
    id: "az-germanywestcentral",
    label: "az-germanywestcentral",
    location: "Azure, Frankfurt, Germany",
    flag: "🇩🇪",
  },
  { id: "az-southeastasia", label: "az-southeastasia", location: "Azure, Singapore", flag: "🇸🇬" },
];

export const REGION_IDS = REGIONS.map((r) => r.id);

/** AWS regions only: VPCs and peering are AWS-only on Tiger Cloud. */
export const AWS_REGIONS = REGIONS.filter((r) => !r.id.startsWith("az-"));

export interface ComputeSize {
  cpuMillis: number;
  memoryGbs: number;
}

/**
 * The CPU/memory pairs the API accepts (tiger-cli `GetAllowedCPUMemoryConfigs`,
 * mirrored from the server's validation). `shared` is create-only; resizes
 * take the dedicated pairs.
 */
export const COMPUTE_SIZES: ComputeSize[] = [
  { cpuMillis: 500, memoryGbs: 2 },
  { cpuMillis: 1000, memoryGbs: 4 },
  { cpuMillis: 2000, memoryGbs: 8 },
  { cpuMillis: 4000, memoryGbs: 16 },
  { cpuMillis: 8000, memoryGbs: 32 },
  { cpuMillis: 16000, memoryGbs: 64 },
  { cpuMillis: 32000, memoryGbs: 128 },
];

/** `"1000/4"`: the id the size pickers and the `computeSize` field use. */
export function sizeId(cpuMillis: number | undefined, memoryGbs: number | undefined): string {
  if (!cpuMillis || !memoryGbs) return "";
  return `${cpuMillis}/${memoryGbs}`;
}

export function parseSizeId(id: string): ComputeSize | null {
  const m = /^(\d+)\/(\d+)$/.exec(id.trim());
  if (!m) return null;
  const size = { cpuMillis: Number(m[1]), memoryGbs: Number(m[2]) };
  return COMPUTE_SIZES.some((s) => s.cpuMillis === size.cpuMillis && s.memoryGbs === size.memoryGbs)
    ? size
    : null;
}

export function sizeLabel(cpuMillis: number, memoryGbs: number): string {
  const cpu = cpuMillis / 1000;
  return `${Number.isInteger(cpu) ? cpu : cpu.toFixed(1)} CPU / ${memoryGbs} GB`;
}

export const SIZE_IDS = COMPUTE_SIZES.map((s) => sizeId(s.cpuMillis, s.memoryGbs));

export const SIZE_OPTIONS: SelectOption[] = COMPUTE_SIZES.map((s) => ({
  id: sizeId(s.cpuMillis, s.memoryGbs),
  label: sizeLabel(s.cpuMillis, s.memoryGbs),
}));

/** Database name and owner every Tiger Cloud service is created with. */
export const DEFAULT_DATABASE = "tsdb";
export const DEFAULT_ROLE = "tsdbadmin";

export const EXPORTER_TYPES: SelectOption[] = [
  { id: "DATADOG_METRICS", label: "Datadog metrics" },
  { id: "PROMETHEUS_METRICS", label: "Prometheus metrics (scrape endpoint)" },
  { id: "CLOUDWATCH_METRICS", label: "Amazon CloudWatch metrics" },
  { id: "CLOUDWATCH_LOGS", label: "Amazon CloudWatch logs" },
  { id: "AZURE_MONITOR_METRICS", label: "Azure Monitor metrics" },
];

export const DATADOG_SITES: SelectOption[] = [
  { id: "datadoghq.com", label: "US1 (datadoghq.com)" },
  { id: "us3.datadoghq.com", label: "US3 (us3.datadoghq.com)" },
  { id: "us5.datadoghq.com", label: "US5 (us5.datadoghq.com)" },
  { id: "datadoghq.eu", label: "EU1 (datadoghq.eu)" },
  { id: "ap1.datadoghq.com", label: "AP1 (ap1.datadoghq.com)" },
  { id: "ap2.datadoghq.com", label: "AP2 (ap2.datadoghq.com)" },
  { id: "ddog-gov.com", label: "US1-FED (ddog-gov.com)" },
];
