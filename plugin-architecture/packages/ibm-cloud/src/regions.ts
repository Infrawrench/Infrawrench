import type { CredentialFieldRegion } from "@infrawrench/plugin-base";

/**
 * IBM Cloud multizone regions. The live list comes from the VPC API
 * (`GET /v1/regions`); this table supplies display names and is the
 * fallback when that call is refused.
 */
export interface IbmRegion {
  id: string;
  label: string;
  location: string;
  flag: string;
}

export const IBM_REGIONS: IbmRegion[] = [
  { id: "us-south", label: "Dallas", location: "Dallas, USA", flag: "🇺🇸" },
  { id: "us-east", label: "Washington DC", location: "Washington DC, USA", flag: "🇺🇸" },
  { id: "ca-tor", label: "Toronto", location: "Toronto, Canada", flag: "🇨🇦" },
  { id: "ca-mon", label: "Montreal", location: "Montreal, Canada", flag: "🇨🇦" },
  { id: "br-sao", label: "Sao Paulo", location: "São Paulo, Brazil", flag: "🇧🇷" },
  { id: "eu-gb", label: "London", location: "London, UK", flag: "🇬🇧" },
  { id: "eu-de", label: "Frankfurt", location: "Frankfurt, Germany", flag: "🇩🇪" },
  { id: "eu-es", label: "Madrid", location: "Madrid, Spain", flag: "🇪🇸" },
  { id: "jp-tok", label: "Tokyo", location: "Tokyo, Japan", flag: "🇯🇵" },
  { id: "jp-osa", label: "Osaka", location: "Osaka, Japan", flag: "🇯🇵" },
  { id: "au-syd", label: "Sydney", location: "Sydney, Australia", flag: "🇦🇺" },
  { id: "in-che", label: "Chennai", location: "Chennai, India", flag: "🇮🇳" },
];

export const DEFAULT_REGION = "us-south";

export const HOME_REGION_OPTIONS: CredentialFieldRegion[] = IBM_REGIONS.map((r) => ({
  id: r.id,
  label: r.label,
  location: r.location,
  flag: r.flag,
}));

export function regionInfo(id: string): IbmRegion | undefined {
  return IBM_REGIONS.find((r) => r.id === id);
}

/** Code Engine regions (Code Engine docs, "Regions and endpoints"). */
export const CODE_ENGINE_REGIONS = new Set([
  "au-syd",
  "br-sao",
  "ca-tor",
  "eu-de",
  "eu-es",
  "eu-gb",
  "jp-osa",
  "jp-tok",
  "us-east",
  "us-south",
]);

export const VPC_API_VERSION = "2026-09-24";

export const vpcBase = (region: string) => `https://${region}.iaas.cloud.ibm.com/v1`;
export const codeEngineBase = (region: string) =>
  `https://api.${region}.codeengine.cloud.ibm.com/v2`;
export const databasesBase = (region: string) =>
  `https://api.${region}.databases.cloud.ibm.com/v5/ibm`;
export const RESOURCE_CONTROLLER = "https://resource-controller.cloud.ibm.com";
export const CONTAINERS = "https://containers.cloud.ibm.com/global";
export const BILLING = "https://billing.cloud.ibm.com";
export const COS_CONFIG = "https://config.cloud-object-storage.cloud.ibm.com/v1";

/**
 * COS S3 endpoint for a bucket location. `LocationConstraint` values are a
 * location plus a storage class (`us-south-smart`, `eu-standard`,
 * `ams03-vault`); regional and cross-region locations both live at
 * `s3.{location}.cloud-object-storage.appdomain.cloud`.
 */
export function cosEndpoint(location: string): string {
  return `s3.${location}.cloud-object-storage.appdomain.cloud`;
}

/** Split `us-south-smart` into `{ location: "us-south", storageClass: "smart" }`. */
export function parseLocationConstraint(value: string): { location: string; storageClass: string } {
  const m = /^(.*)-(standard|vault|cold|smart|flex|onerate_active)$/.exec(value);
  return m ? { location: m[1]!, storageClass: m[2]! } : { location: value, storageClass: "" };
}

/** Service name inside a CRN: `crn:v1:bluemix:public:{service}:{location}:a/{account}:{guid}::`. */
export function crnService(crn: string): string {
  return crn.split(":")[4] ?? "";
}

export function crnLocation(crn: string): string {
  return crn.split(":")[5] ?? "";
}
