import type {
  CreateFieldConfig,
  CreateResourceConfig,
  ImageOption,
  RegionOption,
  ResourceInstance,
  SelectOption,
  SizeOption,
} from "@infrawrench/plugin-base";
import { AliApiError, mapLimit } from "./api.js";
import {
  bucketInfo,
  describeDomains,
  getInstance,
  makeResource,
  mapBucket,
  mapRds,
  mapRecord,
  mapRedis,
  ramUserResource,
  rdsAttribute,
  type DnsRecord,
  type ListContext,
} from "./listers.js";
import { OSS_REGIONS, productInRegion, regionInfo } from "./regions.js";
import { getResourceByExternalId } from "./get.js";
import { sha256Hex } from "./signer.js";

/**
 * Create forms and handlers. Nothing asks for an id: regions come from the
 * account's region list, zones from `DescribeZones` (a region-picker narrowed
 * by the chosen region), instance types from `DescribeInstanceTypes` narrowed
 * per region by `DescribeAvailableResource`, RDS classes from `ListClasses`,
 * and VPCs, vSwitches, security groups and disks through resource pickers.
 */

const PID = "alibaba-cloud";

const nameField = (label = "Name", description?: string): CreateFieldConfig => ({
  key: "name",
  label,
  kind: "text",
  required: true,
  ...(description ? { description } : {}),
});

function regionOption(id: string): RegionOption {
  const info = regionInfo(id);
  return {
    id,
    label: info?.label ?? id,
    ...(info ? { location: info.location, flag: info.flag } : {}),
  };
}

async function regionField(
  ctx: ListContext,
  filter: (region: string) => boolean = () => true,
): Promise<CreateFieldConfig> {
  const regions = (await ctx.inventory.regions().catch(() => [ctx.inventory.homeRegion])).filter(
    filter,
  );
  const home = regions.includes(ctx.inventory.homeRegion) ? ctx.inventory.homeRegion : regions[0];
  return {
    key: "region",
    label: "Region",
    kind: "region-picker",
    required: true,
    regions: regions.map(regionOption),
    ...(home ? { defaultValue: home } : {}),
  };
}

/** Zones of every scanned region, narrowed in the form by the chosen region. */
async function zoneField(ctx: ListContext, required: boolean): Promise<CreateFieldConfig> {
  const regions = await ctx.inventory.regions().catch(() => [ctx.inventory.homeRegion]);
  const perRegion = await mapLimit(regions, 6, async (region) => {
    try {
      const res = await ctx.api.rpc<{
        Zones?: { Zone?: Array<{ ZoneId: string; LocalName?: string }> };
      }>("ecs", region, "DescribeZones", { RegionId: region, AcceptLanguage: "en-US" });
      return (res.Zones?.Zone ?? []).map((z) => ({ ...z, region }));
    } catch {
      return [];
    }
  });
  return {
    key: "zoneId",
    label: "Zone",
    kind: "region-picker",
    required,
    filterByFieldKey: "region",
    regions: perRegion.flat().map((z) => ({
      id: z.ZoneId,
      label: z.ZoneId,
      ...(z.LocalName ? { location: z.LocalName } : {}),
      availableFor: [z.region],
    })),
  };
}

const picker = (
  key: string,
  label: string,
  typeId: string,
  required: boolean,
  description?: string,
): CreateFieldConfig => ({
  key,
  label,
  kind: "resource-picker",
  required,
  associationSources: [{ pluginId: PID, resourceTypeId: typeId, outputKey: "id" }],
  scopeFromFieldKey: "region",
  ...(description ? { description } : {}),
});

// ---------------------------------------------------------------------------
// ECS catalogue

/** Families offered in the size picker: current general, compute, memory, burstable, ARM. */
export const ECS_FAMILIES = [
  "ecs.t6",
  "ecs.e",
  "ecs.u1",
  "ecs.g7",
  "ecs.c7",
  "ecs.r7",
  "ecs.g8i",
  "ecs.c8i",
  "ecs.r8i",
  "ecs.g8a",
  "ecs.c8a",
  "ecs.r8a",
  "ecs.g8y",
  "ecs.c8y",
];

interface InstanceTypeInfo {
  InstanceTypeId: string;
  InstanceTypeFamily?: string;
  CpuCoreCount?: number;
  MemorySize?: number;
  GPUAmount?: number;
  CpuArchitecture?: string;
}

export async function listInstanceTypes(ctx: ListContext): Promise<InstanceTypeInfo[]> {
  const out: InstanceTypeInfo[] = [];
  for (let i = 0; i < ECS_FAMILIES.length; i += 10) {
    let token: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await ctx.api.rpc<{
        InstanceTypes?: { InstanceType?: InstanceTypeInfo[] };
        NextToken?: string;
      }>("ecs", ctx.inventory.homeRegion, "DescribeInstanceTypes", {
        InstanceTypeFamilies: ECS_FAMILIES.slice(i, i + 10),
        MaxResults: 1600,
        NextToken: token,
      });
      out.push(...(res.InstanceTypes?.InstanceType ?? []));
      token = res.NextToken;
      if (!token) break;
    }
  }
  return out.filter((t) => (t.CpuCoreCount ?? 0) <= 64);
}

/** Instance types on sale, per zone, in a region (pay-as-you-go). */
export async function availableTypes(
  ctx: ListContext,
  region: string,
  instanceType?: string,
): Promise<Map<string, Set<string>>> {
  const res = await ctx.api.rpc<{
    AvailableZones?: {
      AvailableZone?: Array<{
        ZoneId: string;
        Status?: string;
        AvailableResources?: {
          AvailableResource?: Array<{
            Type?: string;
            SupportedResources?: { SupportedResource?: Array<{ Value: string; Status?: string }> };
          }>;
        };
      }>;
    };
  }>("ecs", region, "DescribeAvailableResource", {
    RegionId: region,
    DestinationResource: "InstanceType",
    InstanceChargeType: "PostPaid",
    IoOptimized: "optimized",
    ...(instanceType ? { InstanceType: instanceType } : {}),
  });
  const byZone = new Map<string, Set<string>>();
  for (const z of res.AvailableZones?.AvailableZone ?? []) {
    if (z.Status && z.Status !== "Available") continue;
    const set = new Set<string>();
    for (const r of z.AvailableResources?.AvailableResource ?? []) {
      for (const s of r.SupportedResources?.SupportedResource ?? []) {
        if (!s.Status || s.Status === "Available") set.add(s.Value);
      }
    }
    byZone.set(z.ZoneId, set);
  }
  return byZone;
}

function sizeCategory(family: string): string {
  if (/\.t\d|\.e$|\.u1/.test(family)) return "Shared and burstable";
  if (/y$/.test(family)) return "Arm (Yitian)";
  if (/\.c\d/.test(family)) return "Compute optimized";
  if (/\.r\d/.test(family)) return "Memory optimized";
  return "General purpose";
}

async function ecsSizes(ctx: ListContext, regions: string[]): Promise<SizeOption[]> {
  const [types, availability] = await Promise.all([
    listInstanceTypes(ctx),
    mapLimit(regions, 6, async (region) => {
      try {
        const zones = await availableTypes(ctx, region);
        const all = new Set<string>();
        for (const s of zones.values()) for (const t of s) all.add(t);
        return { region, types: all as Set<string> | null };
      } catch {
        return { region, types: null as Set<string> | null };
      }
    }),
  ]);
  return types
    .sort(
      (a, b) =>
        (a.InstanceTypeFamily ?? "").localeCompare(b.InstanceTypeFamily ?? "") ||
        (a.CpuCoreCount ?? 0) - (b.CpuCoreCount ?? 0) ||
        (a.MemorySize ?? 0) - (b.MemorySize ?? 0),
    )
    .map((t) => {
      // A region whose availability could not be read offers every type;
      // the handler re-checks against the chosen zone.
      const availableFor = availability
        .filter((a) => a.types === null || a.types.has(t.InstanceTypeId))
        .map((a) => a.region);
      return {
        id: t.InstanceTypeId,
        label: t.InstanceTypeId,
        vcpus: t.CpuCoreCount ?? 0,
        memoryMb: Math.round((t.MemorySize ?? 0) * 1024),
        category: sizeCategory(t.InstanceTypeFamily ?? ""),
        availableFor,
      };
    })
    .filter((s) => s.availableFor.length > 0);
}

/**
 * System images offered by OS. Image ids are regional and change with every
 * patch release, so the handler resolves the newest matching public image
 * in the chosen region and architecture.
 */
export const ECS_IMAGES: Array<ImageOption & { match: RegExp; windows?: boolean }> = [
  {
    id: "aliyun3",
    label: "Alibaba Cloud Linux 3",
    category: "Alibaba Cloud Linux",
    match: /Alibaba Cloud Linux\s*3/i,
  },
  { id: "ubuntu-24.04", label: "Ubuntu 24.04", category: "Ubuntu", match: /Ubuntu\s*24\.04/i },
  { id: "ubuntu-22.04", label: "Ubuntu 22.04", category: "Ubuntu", match: /Ubuntu\s*22\.04/i },
  { id: "debian-12", label: "Debian 12", category: "Debian", match: /Debian\s*12/i },
  { id: "rocky-9", label: "Rocky Linux 9", category: "Rocky Linux", match: /Rocky Linux\s*9/i },
  {
    id: "windows-2022",
    label: "Windows Server 2022",
    category: "Windows",
    match: /Windows Server\s*2022/i,
    windows: true,
  },
];

export async function resolveImage(
  ctx: ListContext,
  region: string,
  imageKey: string,
  arch: "x86_64" | "arm64",
): Promise<string> {
  const spec = ECS_IMAGES.find((i) => i.id === imageKey);
  if (!spec) {
    // An explicit image id (custom image) passes through.
    if (/^m-|_/.test(imageKey)) return imageKey;
    throw Object.assign(new Error(`Unknown image "${imageKey}"`), { status: 400 });
  }
  const images: Array<{
    ImageId: string;
    OSNameEn?: string;
    OSName?: string;
    CreationTime?: string;
  }> = [];
  for (let page = 1; page <= 5; page++) {
    const res = await ctx.api.rpc<{
      Images?: {
        Image?: Array<{
          ImageId: string;
          OSNameEn?: string;
          OSName?: string;
          CreationTime?: string;
        }>;
      };
      TotalCount?: number;
    }>("ecs", region, "DescribeImages", {
      RegionId: region,
      ImageOwnerAlias: "system",
      OSType: spec.windows ? "windows" : "linux",
      Architecture: arch,
      Status: "Available",
      PageNumber: page,
      PageSize: 100,
    });
    const batch = res.Images?.Image ?? [];
    images.push(...batch);
    if (batch.length < 100) break;
  }
  const match = images
    .filter((i) => spec.match.test(i.OSNameEn || i.OSName || ""))
    .sort((a, b) => (b.CreationTime ?? "").localeCompare(a.CreationTime ?? ""))[0];
  if (!match) {
    throw Object.assign(
      new Error(`No ${spec.label} (${arch}) public image is available in ${region}.`),
      { status: 400 },
    );
  }
  return match.ImageId;
}

const DISK_CATEGORIES: SelectOption[] = [
  { id: "cloud_essd", label: "ESSD PL1", description: "Enterprise SSD, 50,000 IOPS ceiling" },
  { id: "cloud_auto", label: "ESSD AutoPL", description: "Performance scales with size and burst" },
  { id: "cloud_essd_entry", label: "ESSD Entry", description: "Lowest-cost ESSD" },
  { id: "cloud_efficiency", label: "Ultra Disk", description: "Previous-generation, cheaper" },
];

// ---------------------------------------------------------------------------
// RDS and Redis catalogues

export const RDS_ENGINES: Array<{ id: string; label: string; engine: string; version: string }> = [
  { id: "MySQL|8.0", label: "MySQL 8.0", engine: "MySQL", version: "8.0" },
  { id: "MySQL|5.7", label: "MySQL 5.7", engine: "MySQL", version: "5.7" },
  { id: "PostgreSQL|17.0", label: "PostgreSQL 17", engine: "PostgreSQL", version: "17.0" },
  { id: "PostgreSQL|16.0", label: "PostgreSQL 16", engine: "PostgreSQL", version: "16.0" },
  { id: "PostgreSQL|15.0", label: "PostgreSQL 15", engine: "PostgreSQL", version: "15.0" },
  { id: "MariaDB|10.3", label: "MariaDB 10.3", engine: "MariaDB", version: "10.3" },
  {
    id: "SQLServer|2022_std_ha",
    label: "SQL Server 2022 Standard",
    engine: "SQLServer",
    version: "2022_std_ha",
  },
];

export interface RdsClass {
  ClassCode: string;
  Cpu?: string;
  MemoryClass?: string;
  ReferencePrice?: string;
  category?: string;
  storageType?: string;
  ClassGroup?: string;
}

/** Pay-as-you-go RDS classes on sale in a region for an engine (international commodity code). */
export async function listRdsClasses(
  ctx: ListContext,
  region: string,
  engine: string,
): Promise<RdsClass[]> {
  const res = await ctx.api.rpc<{ Items?: RdsClass[] }>("rds", region, "ListClasses", {
    CommodityCode: "bards_intl",
    OrderType: "BUY",
    RegionId: region,
    Engine: engine,
  });
  return res.Items ?? [];
}

async function rdsSizes(ctx: ListContext): Promise<SizeOption[]> {
  const region = productInRegion("rds", ctx.inventory.homeRegion)
    ? ctx.inventory.homeRegion
    : "ap-southeast-1";
  const engines = [...new Set(RDS_ENGINES.map((e) => e.engine))];
  const perEngine = await mapLimit(engines, 2, async (engine) => ({
    engine,
    classes: await listRdsClasses(ctx, region, engine).catch(() => [] as RdsClass[]),
  }));
  const out = new Map<string, SizeOption>();
  for (const { engine, classes } of perEngine) {
    const ids = RDS_ENGINES.filter((e) => e.engine === engine).map((e) => e.id);
    for (const c of classes) {
      if (c.category && !["Basic", "HighAvailability"].includes(c.category)) continue;
      const existing = out.get(c.ClassCode);
      if (existing) {
        existing.availableFor = [...new Set([...(existing.availableFor ?? []), ...ids])];
        continue;
      }
      const hourlyCents = Number(c.ReferencePrice);
      out.set(c.ClassCode, {
        id: c.ClassCode,
        label: c.ClassCode,
        vcpus: Number(c.Cpu) || 0,
        memoryMb: Math.round((parseFloat(c.MemoryClass ?? "0") || 0) * 1024),
        category: c.category === "Basic" ? "Basic (single node)" : "High availability",
        ...(Number.isFinite(hourlyCents) && hourlyCents > 0
          ? { priceMonthly: Math.round((hourlyCents / 100) * 730 * 100) / 100 }
          : {}),
        availableFor: ids,
      });
    }
  }
  return [...out.values()].sort((a, b) => a.vcpus - b.vcpus || a.memoryMb - b.memoryMb);
}

/**
 * Redis Open-Source Edition cloud-native standard (high availability)
 * classes, from Alibaba's instance-type table (2026-10).
 */
export const REDIS_CLASSES: Array<{ id: string; memoryGb: number }> = [
  { id: "redis.shard.small.2.ce", memoryGb: 1 },
  { id: "redis.shard.mid.2.ce", memoryGb: 2 },
  { id: "redis.shard.large.ce", memoryGb: 4 },
  { id: "redis.shard.xlarge.ce", memoryGb: 8 },
  { id: "redis.shard.2xlarge.ce", memoryGb: 16 },
  { id: "redis.shard.3xlarge.ce", memoryGb: 24 },
  { id: "redis.shard.4xlarge.ce", memoryGb: 32 },
  { id: "redis.shard.8xlarge.ce", memoryGb: 64 },
];

// ---------------------------------------------------------------------------
// Forms

export async function getCreateConfig(
  ctx: ListContext,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig> {
  switch (typeId) {
    case "ecs-instance": {
      const region = await regionField(ctx);
      const sizes = await ecsSizes(ctx, region.regions?.map((r) => r.id) ?? []);
      const defaultSize =
        sizes.find((s) => s.id === "ecs.g7.large")?.id ??
        sizes.find((s) => s.vcpus === 2 && s.memoryMb === 8192)?.id ??
        sizes[0]?.id;
      return {
        fields: [
          nameField("Name", "Instance name, also used as the hostname"),
          region,
          {
            key: "instanceType",
            label: "Instance Type",
            kind: "size-picker",
            required: true,
            sizes,
            filterByFieldKey: "region",
            ...(defaultSize ? { defaultValue: defaultSize } : {}),
          },
          {
            key: "image",
            label: "Image",
            kind: "image-picker",
            required: true,
            images: ECS_IMAGES.map(({ id, label, category }) => ({
              id,
              label,
              ...(category ? { category } : {}),
            })),
            defaultValue: "ubuntu-24.04",
          },
          {
            key: "systemDiskGb",
            label: "System Disk",
            kind: "disk-slider",
            required: false,
            minGb: 20,
            maxGb: 2048,
            defaultGb: 40,
            stepGb: 10,
          },
          {
            key: "diskCategory",
            label: "Disk Type",
            kind: "select",
            required: false,
            defaultValue: "cloud_essd",
            options: DISK_CATEGORIES,
          },
          picker(
            "vswitchId",
            "vSwitch",
            "vswitch",
            false,
            "Leave empty to use the region's default VPC, in a zone where the instance type is on sale",
          ),
          picker(
            "securityGroupId",
            "Security Group",
            "security-group",
            false,
            "Leave empty to create (or reuse) an infrawrench-ssh group that allows SSH in",
          ),
          {
            key: "publicBandwidth",
            label: "Public Bandwidth (Mbps)",
            kind: "number",
            required: false,
            defaultValue: "5",
            minValue: 0,
            maxValue: 100,
            description:
              "Peak outbound bandwidth, billed by traffic. 0 gives the instance no public IP.",
          },
          { key: "sshPublicKey", label: "SSH Key", kind: "ssh-key-picker", required: false },
        ],
      };
    }
    case "disk":
      return {
        fields: [
          nameField(),
          await regionField(ctx),
          await zoneField(ctx, true),
          {
            key: "sizeGb",
            label: "Size",
            kind: "disk-slider",
            required: true,
            minGb: 20,
            maxGb: 32768,
            defaultGb: 40,
            stepGb: 10,
          },
          {
            key: "category",
            label: "Disk Type",
            kind: "select",
            required: true,
            defaultValue: "cloud_essd",
            options: DISK_CATEGORIES,
          },
        ],
      };
    case "snapshot":
      return {
        fields: [
          nameField(),
          await regionField(ctx),
          picker("diskId", "Disk", "disk", true),
          {
            key: "retentionDays",
            label: "Keep For (days)",
            kind: "number",
            required: false,
            minValue: 1,
            maxValue: 65536,
            description: "Leave empty to keep the snapshot until you delete it",
          },
        ],
      };
    case "vpc":
      return {
        fields: [
          nameField(),
          await regionField(ctx),
          {
            key: "cidrBlock",
            label: "IPv4 CIDR Block",
            kind: "text",
            required: true,
            defaultValue: "172.16.0.0/12",
            placeholder: "172.16.0.0/12",
            description: "10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 or a subnet of one of them",
          },
          { key: "description", label: "Description", kind: "text", required: false },
        ],
      };
    case "vswitch":
      return {
        fields: [
          nameField(),
          await regionField(ctx),
          picker("vpcId", "VPC", "vpc", true),
          await zoneField(ctx, true),
          {
            key: "cidrBlock",
            label: "IPv4 CIDR Block",
            kind: "text",
            required: true,
            defaultValue: "172.16.0.0/24",
            placeholder: "172.16.0.0/24",
            description: "Inside the VPC's block, /16 to /29",
          },
          { key: "description", label: "Description", kind: "text", required: false },
        ],
      };
    case "security-group":
      return {
        fields: [
          nameField(),
          await regionField(ctx),
          picker("vpcId", "VPC", "vpc", true),
          {
            key: "rules",
            label: "Inbound Rules",
            kind: "select",
            required: true,
            defaultValue: "ssh",
            options: [
              { id: "ssh", label: "SSH (22) from anywhere" },
              { id: "web", label: "SSH, HTTP and HTTPS from anywhere" },
              { id: "none", label: "None (only traffic from the same group)" },
            ],
          },
          { key: "description", label: "Description", kind: "text", required: false },
        ],
      };
    case "eip":
      return {
        fields: [
          nameField(),
          await regionField(ctx, (r) => productInRegion("vpc", r)),
          {
            key: "bandwidthMbps",
            label: "Bandwidth (Mbps)",
            kind: "number",
            required: true,
            defaultValue: "5",
            minValue: 1,
            maxValue: 500,
          },
          {
            key: "internetChargeType",
            label: "Metering",
            kind: "select",
            required: true,
            defaultValue: "PayByTraffic",
            options: [
              { id: "PayByTraffic", label: "Pay by traffic" },
              { id: "PayByBandwidth", label: "Pay by bandwidth" },
            ],
          },
        ],
      };
    case "rds-instance":
      return {
        fields: [
          nameField("Description"),
          await regionField(ctx, (r) => productInRegion("rds", r)),
          {
            key: "engine",
            label: "Engine",
            kind: "select",
            required: true,
            defaultValue: "MySQL|8.0",
            options: RDS_ENGINES.map((e) => ({ id: e.id, label: e.label })),
          },
          {
            key: "instanceClass",
            label: "Instance Class",
            kind: "size-picker",
            required: true,
            sizes: await rdsSizes(ctx),
            filterByFieldKey: "engine",
            description:
              "Classes on sale in your default region; prices are Alibaba's pay-as-you-go reference prices",
          },
          {
            key: "storageGb",
            label: "Storage",
            kind: "disk-slider",
            required: true,
            minGb: 20,
            maxGb: 32000,
            defaultGb: 50,
            stepGb: 5,
          },
          picker("vswitchId", "vSwitch", "vswitch", true, "The instance's zone is the vSwitch's"),
          {
            key: "securityIps",
            label: "Allowed IPs",
            kind: "text",
            required: false,
            defaultValue: "127.0.0.1",
            description:
              "Comma-separated IPs or CIDR blocks allowed to connect. Add your VPC's CIDR block to reach it from ECS.",
          },
        ],
      };
    case "redis-instance":
      return {
        fields: [
          nameField(),
          await regionField(ctx, (r) => productInRegion("redis", r)),
          {
            key: "instanceClass",
            label: "Memory",
            kind: "select",
            required: true,
            defaultValue: "redis.shard.small.2.ce",
            options: REDIS_CLASSES.map((c) => ({
              id: c.id,
              label: `${c.memoryGb} GB`,
              description: c.id,
            })),
            description: "Standard (master-replica) architecture",
          },
          {
            key: "engineVersion",
            label: "Redis Version",
            kind: "select",
            required: true,
            defaultValue: "7.0",
            options: ["7.0", "6.0", "5.0"].map((v) => ({ id: v, label: `Redis ${v}` })),
          },
          picker("vswitchId", "vSwitch", "vswitch", true, "The instance's zone is the vSwitch's"),
          {
            key: "password",
            label: "Password",
            kind: "password",
            required: false,
            description:
              "8 to 32 characters with three of: upper case, lower case, digits, special characters. Leave empty to set one later.",
          },
        ],
      };
    case "oss-bucket":
      return {
        fields: [
          nameField(
            "Bucket Name",
            "3 to 63 lower-case letters, digits and hyphens; unique across all of OSS",
          ),
          await regionField(ctx, (r) => OSS_REGIONS.has(r)),
          {
            key: "storageClass",
            label: "Storage Class",
            kind: "select",
            required: true,
            defaultValue: "Standard",
            options: [
              { id: "Standard", label: "Standard" },
              { id: "IA", label: "Infrequent Access" },
              { id: "Archive", label: "Archive" },
              { id: "ColdArchive", label: "Cold Archive" },
            ],
          },
          {
            key: "redundancy",
            label: "Redundancy",
            kind: "select",
            required: true,
            defaultValue: "LRS",
            options: [
              { id: "LRS", label: "Locally redundant (one zone)" },
              { id: "ZRS", label: "Zone redundant (three zones, where offered)" },
            ],
          },
          {
            key: "acl",
            label: "Access",
            kind: "select",
            required: true,
            defaultValue: "private",
            options: [
              { id: "private", label: "Private" },
              { id: "public-read", label: "Public read" },
            ],
          },
        ],
      };
    case "dns-domain":
      return {
        fields: [
          {
            key: "name",
            label: "Domain",
            kind: "text",
            required: true,
            placeholder: "example.com",
            description: "Point the domain's nameservers at the ones Alibaba Cloud DNS assigns",
          },
        ],
      };
    case "dns-record": {
      const fields: CreateFieldConfig[] = [];
      if (!parentResourceId) {
        const domains = await describeDomains(ctx.api).catch(() => []);
        fields.push({
          key: "domain",
          label: "Domain",
          kind: "select",
          required: true,
          options: domains.map((d) => ({ id: d.DomainName, label: d.DomainName })),
        });
      }
      fields.push(
        {
          key: "name",
          label: "Host",
          kind: "text",
          required: true,
          defaultValue: "@",
          description: "@ for the domain itself, * for a wildcard, or a subdomain such as www",
        },
        {
          key: "type",
          label: "Type",
          kind: "select",
          required: true,
          defaultValue: "A",
          options: ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA"].map((t) => ({
            id: t,
            label: t,
          })),
        },
        { key: "content", label: "Value", kind: "text", required: true },
        {
          key: "ttl",
          label: "TTL (seconds)",
          kind: "number",
          required: false,
          defaultValue: "600",
          minValue: 1,
          maxValue: 86400,
        },
        {
          key: "priority",
          label: "Priority",
          kind: "number",
          required: false,
          minValue: 1,
          maxValue: 50,
          showWhen: { fieldKey: "type", fieldValue: "MX" },
        },
      );
      return { fields };
    }
    case "ram-user":
      return {
        fields: [
          nameField(
            "User Name",
            "Letters, digits, periods, hyphens and underscores, up to 64 characters",
          ),
          { key: "displayName", label: "Display Name", kind: "text", required: false },
          { key: "email", label: "Email", kind: "text", required: false },
          { key: "comments", label: "Comments", kind: "text", required: false },
        ],
      };
    default:
      throw Object.assign(new Error(`Alibaba Cloud plugin: "${typeId}" cannot be created`), {
        status: 400,
      });
  }
}

// ---------------------------------------------------------------------------
// Handlers

function required(fields: Record<string, string>, key: string, label = key): string {
  const v = (fields[key] ?? "").trim();
  if (!v) throw Object.assign(new Error(`${label} is required`), { status: 400 });
  return v;
}

async function ensureKeyPair(ctx: ListContext, region: string, publicKey: string): Promise<string> {
  const body = publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
  const name = `infrawrench-${(await sha256Hex(body)).slice(0, 16)}`;
  const existing = await ctx.api.rpc<{ KeyPairs?: { KeyPair?: Array<{ KeyPairName: string }> } }>(
    "ecs",
    region,
    "DescribeKeyPairs",
    { RegionId: region, KeyPairName: name },
  );
  if ((existing.KeyPairs?.KeyPair ?? []).some((k) => k.KeyPairName === name)) return name;
  try {
    await ctx.api.rpc("ecs", region, "ImportKeyPair", {
      RegionId: region,
      KeyPairName: name,
      PublicKeyBody: body,
    });
  } catch (err) {
    if (!(err instanceof AliApiError && /AlreadyExist/i.test(err.code))) throw err;
  }
  return name;
}

interface VSwitchInfo {
  VSwitchId: string;
  VpcId: string;
  ZoneId: string;
}

async function describeVSwitch(ctx: ListContext, region: string, id: string): Promise<VSwitchInfo> {
  const res = await ctx.api.rpc<{ VSwitches?: { VSwitch?: VSwitchInfo[] } }>(
    "vpc",
    region,
    "DescribeVSwitches",
    { RegionId: region, VSwitchId: id },
  );
  const found = res.VSwitches?.VSwitch?.[0];
  if (!found)
    throw Object.assign(new Error(`vSwitch ${id} not found in ${region}`), { status: 404 });
  return found;
}

/** A vSwitch in the default VPC whose zone sells the instance type. */
async function defaultVSwitch(
  ctx: ListContext,
  region: string,
  instanceType: string,
): Promise<VSwitchInfo> {
  const zones = await availableTypes(ctx, region, instanceType);
  const okZones = [...zones.entries()].filter(([, t]) => t.has(instanceType)).map(([z]) => z);
  const vpcs = await ctx.api.rpc<{ Vpcs?: { Vpc?: Array<{ VpcId: string }> } }>(
    "vpc",
    region,
    "DescribeVpcs",
    { RegionId: region, IsDefault: true, PageSize: 10 },
  );
  const vpcId = vpcs.Vpcs?.Vpc?.[0]?.VpcId;
  if (vpcId) {
    const switches = await ctx.api.rpc<{ VSwitches?: { VSwitch?: VSwitchInfo[] } }>(
      "vpc",
      region,
      "DescribeVSwitches",
      { RegionId: region, VpcId: vpcId, PageSize: 50 },
    );
    const match = (switches.VSwitches?.VSwitch ?? []).find((s) => okZones.includes(s.ZoneId));
    if (match) return match;
  }
  throw Object.assign(
    new Error(
      `No vSwitch in ${region}'s default VPC is in a zone that sells ${instanceType}${okZones.length ? ` (on sale in ${okZones.join(", ")})` : " (sold out in every zone)"}. Create a vSwitch in one of those zones and pick it.`,
    ),
    { status: 400 },
  );
}

const RULESETS: Record<string, string[]> = {
  ssh: ["22/22"],
  web: ["22/22", "80/80", "443/443"],
  none: [],
};

async function authorizeIngress(
  ctx: ListContext,
  region: string,
  groupId: string,
  portRanges: string[],
): Promise<void> {
  if (!portRanges.length) return;
  await ctx.api.rpc("ecs", region, "AuthorizeSecurityGroup", {
    RegionId: region,
    SecurityGroupId: groupId,
    Permissions: portRanges.map((p) => ({
      IpProtocol: "TCP",
      PortRange: p,
      SourceCidrIp: "0.0.0.0/0",
      Policy: "Accept",
      Priority: "1",
      Description: "Added by Infrawrench",
    })),
  });
}

async function sshSecurityGroup(ctx: ListContext, region: string, vpcId: string): Promise<string> {
  const res = await ctx.api.rpc<{
    SecurityGroups?: { SecurityGroup?: Array<{ SecurityGroupId: string }> };
  }>("ecs", region, "DescribeSecurityGroups", {
    RegionId: region,
    VpcId: vpcId,
    SecurityGroupName: "infrawrench-ssh",
  });
  const found = res.SecurityGroups?.SecurityGroup?.[0]?.SecurityGroupId;
  if (found) return found;
  const created = await ctx.api.rpc<{ SecurityGroupId: string }>(
    "ecs",
    region,
    "CreateSecurityGroup",
    {
      RegionId: region,
      VpcId: vpcId,
      SecurityGroupName: "infrawrench-ssh",
      Description: "SSH access, created by Infrawrench",
    },
  );
  await authorizeIngress(ctx, region, created.SecurityGroupId, RULESETS["ssh"]!);
  return created.SecurityGroupId;
}

async function instanceArch(ctx: ListContext, instanceType: string): Promise<"x86_64" | "arm64"> {
  const res = await ctx.api
    .rpc<{ InstanceTypes?: { InstanceType?: InstanceTypeInfo[] } }>(
      "ecs",
      ctx.inventory.homeRegion,
      "DescribeInstanceTypes",
      { InstanceTypes: [instanceType] },
    )
    .catch(() => undefined);
  const arch = res?.InstanceTypes?.InstanceType?.[0]?.CpuArchitecture;
  return arch === "ARM" ? "arm64" : "x86_64";
}

/** Wait briefly for a resource that the API returns before it is listable. */
async function eventually<T>(fn: () => Promise<T>, attempts = 6, delayMs = 2000): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw last;
}

async function createInstance(ctx: ListContext, fields: Record<string, string>) {
  const region = required(fields, "region", "Region");
  const instanceType = required(fields, "instanceType", "Instance type");
  const name = required(fields, "name", "Name");
  const vswitch = fields["vswitchId"]
    ? await describeVSwitch(ctx, region, fields["vswitchId"])
    : await defaultVSwitch(ctx, region, instanceType);
  const securityGroupId =
    fields["securityGroupId"] || (await sshSecurityGroup(ctx, region, vswitch.VpcId));
  const arch = await instanceArch(ctx, instanceType);
  const imageId = await resolveImage(ctx, region, fields["image"] || "ubuntu-24.04", arch);
  const keyPairName = fields["sshPublicKey"]
    ? await ensureKeyPair(ctx, region, fields["sshPublicKey"])
    : undefined;
  const bandwidth = Number(fields["publicBandwidth"] ?? "5");
  const res = await ctx.api.rpc<{ InstanceIdSets?: { InstanceIdSet?: string[] } }>(
    "ecs",
    region,
    "RunInstances",
    {
      RegionId: region,
      ZoneId: vswitch.ZoneId,
      InstanceType: instanceType,
      ImageId: imageId,
      VSwitchId: vswitch.VSwitchId,
      SecurityGroupId: securityGroupId,
      InstanceName: name,
      HostName: name.replace(/[^A-Za-z0-9.-]/g, "-").slice(0, 64),
      InstanceChargeType: "PostPaid",
      InternetChargeType: "PayByTraffic",
      InternetMaxBandwidthOut: Number.isFinite(bandwidth) ? Math.max(0, bandwidth) : 5,
      "SystemDisk.Category": fields["diskCategory"] || "cloud_essd",
      "SystemDisk.Size": fields["systemDiskGb"] || "40",
      KeyPairName: keyPairName,
      Amount: 1,
    },
  );
  const id = res.InstanceIdSets?.InstanceIdSet?.[0];
  if (!id) throw Object.assign(new Error("RunInstances returned no instance id"), { status: 502 });
  return eventually(() => getInstance(ctx, region, id));
}

export async function createResource(
  ctx: ListContext,
  typeId: string,
  fields: Record<string, string>,
  parentResourceId?: string,
): Promise<ResourceInstance> {
  const region = fields["region"] ?? "";
  const get = (type: string, externalId: string) => getResourceByExternalId(ctx, type, externalId);
  switch (typeId) {
    case "ecs-instance":
      return createInstance(ctx, fields);
    case "disk": {
      const res = await ctx.api.rpc<{ DiskId: string }>("ecs", region, "CreateDisk", {
        RegionId: required(fields, "region", "Region"),
        ZoneId: required(fields, "zoneId", "Zone"),
        DiskName: required(fields, "name", "Name"),
        Size: required(fields, "sizeGb", "Size"),
        DiskCategory: fields["category"] || "cloud_essd",
      });
      return eventually(() => get("disk", `${region}/${res.DiskId}`));
    }
    case "snapshot": {
      const res = await ctx.api.rpc<{ SnapshotId: string }>("ecs", region, "CreateSnapshot", {
        DiskId: required(fields, "diskId", "Disk"),
        SnapshotName: required(fields, "name", "Name"),
        RetentionDays: fields["retentionDays"] || undefined,
      });
      return eventually(() => get("snapshot", `${region}/${res.SnapshotId}`));
    }
    case "vpc": {
      const res = await ctx.api.rpc<{ VpcId: string }>("vpc", region, "CreateVpc", {
        RegionId: required(fields, "region", "Region"),
        VpcName: required(fields, "name", "Name"),
        CidrBlock: required(fields, "cidrBlock", "CIDR block"),
        Description: fields["description"] || undefined,
      });
      return eventually(() => get("vpc", `${region}/${res.VpcId}`));
    }
    case "vswitch": {
      const res = await ctx.api.rpc<{ VSwitchId: string }>("vpc", region, "CreateVSwitch", {
        RegionId: required(fields, "region", "Region"),
        VpcId: required(fields, "vpcId", "VPC"),
        ZoneId: required(fields, "zoneId", "Zone"),
        VSwitchName: required(fields, "name", "Name"),
        CidrBlock: required(fields, "cidrBlock", "CIDR block"),
        Description: fields["description"] || undefined,
      });
      return eventually(() => get("vswitch", `${region}/${res.VSwitchId}`));
    }
    case "security-group": {
      const res = await ctx.api.rpc<{ SecurityGroupId: string }>(
        "ecs",
        region,
        "CreateSecurityGroup",
        {
          RegionId: required(fields, "region", "Region"),
          VpcId: required(fields, "vpcId", "VPC"),
          SecurityGroupName: required(fields, "name", "Name"),
          Description: fields["description"] || undefined,
        },
      );
      await authorizeIngress(
        ctx,
        region,
        res.SecurityGroupId,
        RULESETS[fields["rules"] ?? "ssh"] ?? [],
      );
      return eventually(() => get("security-group", `${region}/${res.SecurityGroupId}`));
    }
    case "eip": {
      const res = await ctx.api.rpc<{ AllocationId: string }>("vpc", region, "AllocateEipAddress", {
        RegionId: required(fields, "region", "Region"),
        Bandwidth: fields["bandwidthMbps"] || "5",
        InternetChargeType: fields["internetChargeType"] || "PayByTraffic",
        InstanceChargeType: "PostPaid",
        Name: fields["name"] || undefined,
      });
      return eventually(() => get("eip", `${region}/${res.AllocationId}`));
    }
    case "rds-instance": {
      const engineKey = required(fields, "engine", "Engine");
      const engine = RDS_ENGINES.find((e) => e.id === engineKey);
      if (!engine) throw Object.assign(new Error(`Unknown engine ${engineKey}`), { status: 400 });
      const classCode = required(fields, "instanceClass", "Instance class");
      const vswitch = await describeVSwitch(ctx, region, required(fields, "vswitchId", "vSwitch"));
      const cls = (await listRdsClasses(ctx, region, engine.engine)).find(
        (c) => c.ClassCode === classCode,
      );
      if (!cls) {
        throw Object.assign(
          new Error(
            `${classCode} is not on sale for ${engine.label} in ${region}. Pick another class.`,
          ),
          { status: 400 },
        );
      }
      const res = await ctx.api.rpc<{ DBInstanceId: string }>("rds", region, "CreateDBInstance", {
        RegionId: region,
        Engine: engine.engine,
        EngineVersion: engine.version,
        DBInstanceClass: classCode,
        DBInstanceStorage: required(fields, "storageGb", "Storage"),
        DBInstanceStorageType: cls.storageType || "cloud_essd",
        Category: cls.category || "HighAvailability",
        DBInstanceNetType: "Intranet",
        InstanceNetworkType: "VPC",
        VPCId: vswitch.VpcId,
        VSwitchId: vswitch.VSwitchId,
        ZoneId: vswitch.ZoneId,
        SecurityIPList: fields["securityIps"] || "127.0.0.1",
        PayType: "Postpaid",
        DBInstanceDescription: required(fields, "name", "Description"),
      });
      return eventually(async () => {
        const attr = await rdsAttribute(ctx.api, region, res.DBInstanceId);
        if (!attr) throw new Error("not yet visible");
        return mapRds(ctx.accountId, region, attr);
      });
    }
    case "redis-instance": {
      const vswitch = await describeVSwitch(ctx, region, required(fields, "vswitchId", "vSwitch"));
      const res = await ctx.api.rpc<Record<string, unknown> & { InstanceId: string }>(
        "redis",
        region,
        "CreateInstance",
        {
          RegionId: region,
          InstanceName: required(fields, "name", "Name"),
          InstanceClass: required(fields, "instanceClass", "Memory"),
          EngineVersion: fields["engineVersion"] || "7.0",
          InstanceType: "Redis",
          NetworkType: "VPC",
          VpcId: vswitch.VpcId,
          VSwitchId: vswitch.VSwitchId,
          ZoneId: vswitch.ZoneId,
          ChargeType: "PostPaid",
          Password: fields["password"] || undefined,
        },
      );
      return mapRedis(ctx.accountId, region, {
        InstanceId: res.InstanceId,
        InstanceName: fields["name"] ?? "",
        ZoneId: vswitch.ZoneId,
        InstanceClass: fields["instanceClass"] ?? "",
        EngineVersion: fields["engineVersion"] || "7.0",
        InstanceStatus: String(res["InstanceStatus"] ?? "Creating"),
        ChargeType: "PostPaid",
        VpcId: vswitch.VpcId,
        VSwitchId: vswitch.VSwitchId,
        ...(typeof res["ConnectionDomain"] === "string"
          ? { ConnectionDomain: res["ConnectionDomain"] }
          : {}),
        ...(typeof res["Port"] === "number" ? { Port: res["Port"] } : {}),
      });
    }
    case "oss-bucket": {
      const name = required(fields, "name", "Bucket name").toLowerCase();
      const bucketRegion = required(fields, "region", "Region");
      const xml = `<?xml version="1.0" encoding="UTF-8"?><CreateBucketConfiguration><StorageClass>${fields["storageClass"] || "Standard"}</StorageClass><DataRedundancyType>${fields["redundancy"] || "LRS"}</DataRedundancyType></CreateBucketConfiguration>`;
      await ctx.api.oss({
        method: "PUT",
        region: bucketRegion,
        bucket: name,
        headers: { "content-type": "application/xml", "x-oss-acl": fields["acl"] || "private" },
        body: xml,
      });
      const info = await bucketInfo(ctx.api, bucketRegion, name).catch(() => undefined);
      return mapBucket(
        ctx.accountId,
        {
          name,
          region: bucketRegion,
          storageClass: fields["storageClass"] || "Standard",
          createdAt: new Date().toISOString(),
        },
        info,
      );
    }
    case "dns-domain": {
      const domain = required(fields, "name", "Domain").toLowerCase().replace(/\.$/, "");
      const res = await ctx.api.rpc<{
        DomainId?: string;
        DnsServers?: { DnsServer?: string[] };
      }>("alidns", "", "AddDomain", { DomainName: domain, Lang: "en" });
      const ns = (res.DnsServers?.DnsServer ?? []).join(", ");
      return makeResource(
        ctx.accountId,
        "dns-domain",
        domain,
        domain,
        { name: domain, nameservers: ns, recordCount: 0 },
        { nameservers: ns, id: res.DomainId },
      );
    }
    case "dns-record": {
      const domain = parentResourceId
        ? parentResourceId.split(":").slice(2).join(":")
        : required(fields, "domain", "Domain");
      const type = required(fields, "type", "Type");
      const rr = required(fields, "name", "Host");
      const value = required(fields, "content", "Value");
      const res = await ctx.api.rpc<{ RecordId: string }>("alidns", "", "AddDomainRecord", {
        DomainName: domain,
        RR: rr,
        Type: type,
        Value: value,
        TTL: fields["ttl"] || undefined,
        Priority: type === "MX" ? fields["priority"] || "10" : undefined,
        Lang: "en",
      });
      const record: DnsRecord = {
        RecordId: res.RecordId,
        RR: rr,
        Type: type,
        Value: value,
        TTL: Number(fields["ttl"] || 600),
        ...(type === "MX" ? { Priority: Number(fields["priority"] || 10) } : {}),
        Line: "default",
        Status: "ENABLE",
      };
      return mapRecord(ctx.accountId, domain, record);
    }
    case "ram-user": {
      const res = await ctx.api.rpc<{
        User?: { UserName: string; UserId?: string; DisplayName?: string; CreateDate?: string };
      }>("ram", "", "CreateUser", {
        UserName: required(fields, "name", "User name"),
        DisplayName: fields["displayName"] || undefined,
        Email: fields["email"] || undefined,
        Comments: fields["comments"] || undefined,
      });
      return ramUserResource(ctx, res.User ?? { UserName: fields["name"]! });
    }
    default:
      throw Object.assign(new Error(`Alibaba Cloud plugin: "${typeId}" cannot be created`), {
        status: 400,
      });
  }
}
