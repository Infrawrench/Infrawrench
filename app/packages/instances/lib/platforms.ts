import { msg } from "gt-react";

/**
 * The clouds the site covers, in the order the site lists them. Each is the
 * first path segment of its pages (`/aws/ec2/m5.large`,
 * `/alibaba/ecs/ecs.g7.large`, `/azure/vms/Standard_D2s_v3`,
 * `/gcp/compute/n2-standard-2`, `/hetzner/cloud/cx23`, `/hetzner/auction/3107671`,
 * `/ovh/cloud/b3-8`, `/ovh/eco/24sys01`, `/oracle/compute/BM.GPU.H100.8`,
 * `/ibm/vpc/bx3d-2x10`, `/runpod/pods/NVIDIA%20H100%2080GB%20HBM3`).
 */
export interface CloudInfo {
  /** As the provider writes its own name. */
  label: string;
}

export const CLOUDS = {
  aws: { label: "AWS" },
  azure: { label: "Azure" },
  gcp: { label: "Google Cloud" },
  alibaba: { label: "Alibaba Cloud" },
  oracle: { label: "Oracle Cloud" },
  ibm: { label: "IBM Cloud" },
  hetzner: { label: "Hetzner" },
  ovh: { label: "OVHcloud" },
  runpod: { label: "RunPod" },
} as const satisfies Readonly<Record<string, CloudInfo>>;

export type Cloud = keyof typeof CLOUDS;

export const CLOUD_IDS = Object.keys(CLOUDS) as Cloud[];

export function isCloud(value: string): value is Cloud {
  return Object.hasOwn(CLOUDS, value);
}

/**
 * The platforms the bulk pricing data covers. Keys match `PLATFORMS` in
 * `app/packages/web/src/aws-bulk-pricing/format.ts`, which is what the sync
 * writes to KV under; `cloud` and `slug` are where its pages live.
 */
export interface PlatformInfo {
  cloud: Cloud;
  /** The URL segment after the cloud; the KV key unless the two differ (`alibaba` is `ecs`). */
  slug: string;
  /** Short name, as the provider writes it. */
  label: string;
  /** What the service is, in a few words (a `msg()` source). */
  summary: string;
  /** Preferred variant fields, most important first; the default variant matches as many as it can. */
  preferredVariant: Readonly<Record<string, string>>;
  /** The reserved option (`termOptionKey`) the page opens on, when the platform sells it. */
  preferredTerm?: string;
  /** The region an instance page opens on, when the instance is offered there. */
  defaultRegion?: string;
  /** What the listing calls names that do not parse as family and size (a `msg()` source); "Other" by default. */
  otherLabel?: string;
}

export const PLATFORMS: Readonly<Record<string, PlatformInfo>> = {
  ec2: {
    cloud: "aws",
    slug: "ec2",
    label: "EC2",
    summary: msg("Virtual servers"),
    preferredVariant: {
      operatingSystem: "Linux",
      tenancy: "Shared",
      capacitystatus: "Used",
      preInstalledSw: "NA",
      licenseModel: "No License required",
    },
  },
  rds: {
    cloud: "aws",
    slug: "rds",
    label: "RDS",
    summary: msg("Managed relational databases"),
    preferredVariant: { databaseEngine: "PostgreSQL", deploymentOption: "Single-AZ" },
  },
  elasticache: {
    cloud: "aws",
    slug: "elasticache",
    label: "ElastiCache",
    summary: msg("In-memory caches"),
    preferredVariant: { cacheEngine: "Redis" },
  },
  opensearch: {
    cloud: "aws",
    slug: "opensearch",
    label: "OpenSearch",
    summary: msg("Search and log analytics"),
    preferredVariant: {},
  },
  redshift: {
    cloud: "aws",
    slug: "redshift",
    label: "Redshift",
    summary: msg("Data warehouse"),
    preferredVariant: {},
  },
  docdb: {
    cloud: "aws",
    slug: "docdb",
    label: "DocumentDB",
    summary: msg("MongoDB-compatible document database"),
    preferredVariant: {},
  },
  neptune: {
    cloud: "aws",
    slug: "neptune",
    label: "Neptune",
    summary: msg("Graph database"),
    preferredVariant: {},
  },
  memorydb: {
    cloud: "aws",
    slug: "memorydb",
    label: "MemoryDB",
    summary: msg("Durable in-memory database"),
    preferredVariant: {},
  },
  dax: {
    cloud: "aws",
    slug: "dax",
    label: "DAX",
    summary: msg("In-memory cache for DynamoDB"),
    preferredVariant: {},
  },
  sagemaker: {
    cloud: "aws",
    slug: "sagemaker",
    label: "SageMaker",
    summary: msg("Machine learning"),
    preferredVariant: {},
  },
  emr: {
    cloud: "aws",
    slug: "emr",
    label: "EMR",
    summary: msg("Big data clusters"),
    preferredVariant: {},
  },
  gamelift: {
    cloud: "aws",
    slug: "gamelift",
    label: "GameLift",
    summary: msg("Game servers"),
    preferredVariant: { operatingSystem: "Linux", isSpotInstance: "No" },
  },
  azure: {
    cloud: "azure",
    slug: "vms",
    label: "Virtual Machines",
    summary: msg("Virtual machines by size"),
    preferredVariant: { operatingSystem: "Linux", priority: "Regular" },
    preferredTerm: "Reserved Instance|All Upfront",
    defaultRegion: "eastus",
  },
  gcp: {
    cloud: "gcp",
    slug: "compute",
    label: "Compute Engine",
    summary: msg("Virtual machines by machine type"),
    preferredVariant: { provisioningModel: "Standard" },
    preferredTerm: "Committed Use|No Upfront",
    defaultRegion: "us-central1",
  },
  alibaba: {
    cloud: "alibaba",
    slug: "ecs",
    label: "ECS",
    summary: msg("Elastic Compute Service virtual servers"),
    preferredVariant: { operatingSystem: "Linux", networkType: "VPC" },
    preferredTerm: "Subscription|All Upfront",
  },
  runpod: {
    cloud: "runpod",
    slug: "pods",
    label: "Pods",
    summary: msg("GPU and CPU pods"),
    preferredVariant: { cloudType: "Secure Cloud" },
    otherLabel: msg("GPUs"),
  },
  hetzner: {
    cloud: "hetzner",
    slug: "cloud",
    label: "Cloud Servers",
    summary: msg("Virtual servers by server type"),
    preferredVariant: { ipv4: "Primary IPv4" },
    preferredTerm: "Monthly Cap|Postpaid",
    defaultRegion: "fsn1",
  },
  hetznerauction: {
    cloud: "hetzner",
    slug: "auction",
    label: "Server Auction",
    summary: msg("Used dedicated servers, each its own listing"),
    preferredVariant: { ipv4: "Primary IPv4" },
    preferredTerm: "Monthly Cap|Postpaid",
    defaultRegion: "fsn1",
    otherLabel: msg("Listings"),
  },
  ovh: {
    cloud: "ovh",
    slug: "cloud",
    label: "Public Cloud",
    summary: msg("Virtual machines by flavor"),
    preferredVariant: { operatingSystem: "Linux" },
    preferredTerm: "Monthly|Postpaid",
    defaultRegion: "world",
  },
  ovheco: {
    cloud: "ovh",
    slug: "eco",
    label: "Eco Servers",
    summary: msg("Kimsufi, So you Start, Rise and Advance dedicated servers"),
    preferredVariant: {},
    preferredTerm: "Prepaid|All Upfront",
    defaultRegion: "gra",
  },
  oracle: {
    cloud: "oracle",
    slug: "compute",
    label: "Compute",
    summary: msg("Virtual machine and bare metal shapes"),
    preferredVariant: { operatingSystem: "Linux" },
    defaultRegion: "global",
  },
  ibm: {
    cloud: "ibm",
    slug: "vpc",
    label: "Virtual Servers for VPC",
    summary: msg("Virtual servers by profile"),
    preferredVariant: { capacityType: "On-Demand" },
    preferredTerm: "Reserved|No Upfront",
    defaultRegion: "us-south",
  },
};

export function platformInfo(platform: string): PlatformInfo | undefined {
  return Object.hasOwn(PLATFORMS, platform) ? PLATFORMS[platform] : undefined;
}

/** The platform (its KV key) whose pages live at `/<cloud>/<slug>`. */
export function platformAt(cloud: string, slug: string): string | undefined {
  return Object.keys(PLATFORMS).find(
    (p) => PLATFORMS[p]!.cloud === cloud && PLATFORMS[p]!.slug === slug,
  );
}

/** A cloud's platforms, in `PLATFORMS` order. */
export function platformsOf(cloud: string): string[] {
  return Object.keys(PLATFORMS).filter((p) => PLATFORMS[p]!.cloud === cloud);
}

/** The cloud a platform belongs to; AWS for anything unknown (the chat's `ec2` rows). */
export function cloudOf(platform: string): Cloud {
  return platformInfo(platform)?.cloud ?? "aws";
}

/** "AWS EC2", "Azure Virtual Machines", "Google Cloud Compute Engine", "RunPod Pods". */
export function fullLabel(platform: string): string {
  const info = platformInfo(platform);
  return info ? `${CLOUDS[info.cloud].label} ${info.label}` : platform;
}

/** `/aws/ec2`, `/alibaba/ecs`. */
export function platformPath(platform: string): string {
  const info = platformInfo(platform);
  return info ? `/${info.cloud}/${info.slug}` : `/aws/${platform}`;
}

/** `/aws/ec2/m5.large`; the name is encoded, since RunPod's have spaces (and a few of Azure's trail one). */
export function instancePath(platform: string, name: string): string {
  return `${platformPath(platform)}/${encodeURIComponent(name)}`;
}

/** Where an instance page opens unless its platform says otherwise. */
export const DEFAULT_REGION_CODE = "us-east-1";
