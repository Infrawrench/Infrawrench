import type { ResourceInstance } from "@infrawrench/plugin-base";
import { isPermissionGap, mapLimit, type AliApi } from "./api.js";
import { nextTokens, pageNumbers, perRegion, type Inventory } from "./inventory.js";
import { OSS_REGIONS, ossEndpoint } from "./regions.js";

/**
 * Listers: one per resource type, each returning `ResourceInstance`s with
 * outputs resolved, so pickers and detail pages need no second round trip.
 * Response field names follow Alibaba's OpenAPI metadata
 * (`api.aliyun.com/meta/v1/products/{Product}/versions/{Version}/api-docs.json`).
 */

export const PLUGIN_ID = "alibaba-cloud";

export interface ListContext {
  api: AliApi;
  inventory: Inventory;
  accountId: string;
  regionHint?: string;
}

type FieldValue = string | number | boolean;

export function makeResource(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, FieldValue | undefined | null>,
  resolvedOutputs: Record<string, string | undefined> = {},
  extra: { createdAt?: string | undefined; parentExternalId?: { typeId: string; id: string } } = {},
): ResourceInstance {
  const created =
    extra.createdAt && !Number.isNaN(Date.parse(extra.createdAt))
      ? new Date(extra.createdAt).toISOString()
      : new Date(0).toISOString();
  const cleanFields: Record<string, FieldValue> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) cleanFields[k] = v;
  }
  const outputs: Record<string, string> = {};
  for (const [k, v] of Object.entries(resolvedOutputs)) if (v) outputs[k] = v;
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: cleanFields,
    resolvedOutputs: outputs,
    secretStates: [],
    externalId,
    createdAt: created,
    updatedAt: created,
    ...(extra.parentExternalId
      ? {
          parentResourceId: `${accountId}:${extra.parentExternalId.typeId}:${extra.parentExternalId.id}`,
        }
      : {}),
  };
}

/** `{region}/{id}` → parts. Ids never contain a slash; ACK node pools carry two. */
export function splitRegional(externalId: string): { region: string; id: string } {
  const i = externalId.indexOf("/");
  if (i < 0) throw new Error(`Alibaba Cloud plugin: malformed resource id "${externalId}"`);
  return { region: externalId.slice(0, i), id: externalId.slice(i + 1) };
}

const join = (values: Array<string | undefined> | undefined) =>
  (values ?? []).filter(Boolean).join(", ");

// ---------------------------------------------------------------------------
// Account

export async function listAccount(ctx: ListContext): Promise<ResourceInstance[]> {
  const [caller, regions] = await Promise.all([
    ctx.inventory.caller(),
    ctx.inventory.regions().catch(() => [ctx.inventory.homeRegion]),
  ]);
  return [
    makeResource(
      ctx.accountId,
      "account",
      caller.AccountId,
      `Alibaba Cloud ${caller.AccountId}`,
      {
        accountId: caller.AccountId,
        identity: caller.Arn ?? "",
        identityType: caller.IdentityType ?? "",
        homeRegion: ctx.inventory.homeRegion,
        regions: regions.join(", "),
      },
      { accountId: caller.AccountId },
    ),
  ];
}

// ---------------------------------------------------------------------------
// ECS

export interface EcsInstance {
  InstanceId: string;
  InstanceName?: string;
  Description?: string;
  RegionId: string;
  ZoneId?: string;
  InstanceType?: string;
  InstanceTypeFamily?: string;
  Cpu?: number;
  Memory?: number;
  GPUAmount?: number;
  Status?: string;
  StoppedMode?: string;
  OSName?: string;
  OSNameEn?: string;
  ImageId?: string;
  PublicIpAddress?: { IpAddress?: string[] };
  EipAddress?: { IpAddress?: string; AllocationId?: string };
  InnerIpAddress?: { IpAddress?: string[] };
  VpcAttributes?: {
    VpcId?: string;
    VSwitchId?: string;
    PrivateIpAddress?: { IpAddress?: string[] };
  };
  SecurityGroupIds?: { SecurityGroupId?: string[] };
  KeyPairName?: string;
  InstanceChargeType?: string;
  InternetMaxBandwidthOut?: number;
  ExpiredTime?: string;
  CreationTime?: string;
  ImageOptions?: { LoginAsNonRoot?: boolean };
}

export function mapInstance(accountId: string, i: EcsInstance): ResourceInstance {
  const publicIp = i.PublicIpAddress?.IpAddress?.[0] || i.EipAddress?.IpAddress || "";
  const privateIp =
    i.VpcAttributes?.PrivateIpAddress?.IpAddress?.[0] || i.InnerIpAddress?.IpAddress?.[0] || "";
  // Subscription instances report a far-future expiry for pay-as-you-go.
  const expired = i.InstanceChargeType === "PrePaid" ? (i.ExpiredTime ?? "") : "";
  return makeResource(
    accountId,
    "ecs-instance",
    `${i.RegionId}/${i.InstanceId}`,
    i.InstanceName || i.InstanceId,
    {
      name: i.InstanceName ?? "",
      description: i.Description ?? "",
      region: i.RegionId,
      zoneId: i.ZoneId ?? "",
      instanceType: i.InstanceType ?? "",
      instanceTypeFamily: i.InstanceTypeFamily ?? "",
      vcpus: i.Cpu,
      memoryGb: i.Memory !== undefined ? Math.round((i.Memory / 1024) * 100) / 100 : undefined,
      gpus: i.GPUAmount || undefined,
      status: i.Status ?? "",
      stoppedMode: i.Status === "Stopped" ? (i.StoppedMode ?? "") : "",
      osName: i.OSNameEn || i.OSName || "",
      imageId: i.ImageId ?? "",
      vpcId: i.VpcAttributes?.VpcId ?? "",
      vswitchId: i.VpcAttributes?.VSwitchId ?? "",
      securityGroupIds: join(i.SecurityGroupIds?.SecurityGroupId),
      keyPairName: i.KeyPairName ?? "",
      chargeType: i.InstanceChargeType ?? "",
      internetMaxBandwidthOut: i.InternetMaxBandwidthOut,
      expiredTime: expired,
      sshUsername: i.ImageOptions?.LoginAsNonRoot ? "ecs-user" : "root",
      createdAt: i.CreationTime ?? "",
    },
    { publicIp, privateIp, id: i.InstanceId },
    { createdAt: i.CreationTime },
  );
}

export async function describeInstances(
  api: AliApi,
  region: string,
  extra: Record<string, unknown> = {},
): Promise<EcsInstance[]> {
  return nextTokens(async (token) => {
    const res = await api.rpc<{ Instances?: { Instance?: EcsInstance[] }; NextToken?: string }>(
      "ecs",
      region,
      "DescribeInstances",
      { RegionId: region, MaxResults: 100, NextToken: token, ...extra },
    );
    return { items: res.Instances?.Instance ?? [], next: res.NextToken };
  });
}

export async function listInstances(ctx: ListContext): Promise<ResourceInstance[]> {
  const all = await perRegion(ctx.inventory, "ecs", ctx.regionHint, (r) =>
    describeInstances(ctx.api, r),
  );
  return all.map((i) => mapInstance(ctx.accountId, i));
}

export async function getInstance(
  ctx: ListContext,
  region: string,
  id: string,
): Promise<ResourceInstance> {
  const [found] = await describeInstances(ctx.api, region, {
    InstanceIds: JSON.stringify([id]),
  });
  if (!found) throw notFound("ecs-instance", `${region}/${id}`);
  return mapInstance(ctx.accountId, found);
}

export function notFound(typeId: string, id: string): Error {
  return Object.assign(new Error(`Alibaba Cloud plugin: ${typeId} ${id} not found`), {
    status: 404,
  });
}

interface EcsDisk {
  DiskId: string;
  DiskName?: string;
  Description?: string;
  RegionId: string;
  ZoneId?: string;
  Size?: number;
  Category?: string;
  PerformanceLevel?: string;
  Type?: string;
  Status?: string;
  InstanceId?: string;
  DeleteWithInstance?: boolean;
  Encrypted?: boolean;
  DiskChargeType?: string;
  CreationTime?: string;
}

export async function listDisks(ctx: ListContext): Promise<ResourceInstance[]> {
  const all = await perRegion(ctx.inventory, "ecs", ctx.regionHint, (region) =>
    nextTokens(async (token) => {
      const res = await ctx.api.rpc<{ Disks?: { Disk?: EcsDisk[] }; NextToken?: string }>(
        "ecs",
        region,
        "DescribeDisks",
        { RegionId: region, MaxResults: 100, NextToken: token },
      );
      return { items: res.Disks?.Disk ?? [], next: res.NextToken };
    }),
  );
  return all.map((d) =>
    makeResource(
      ctx.accountId,
      "disk",
      `${d.RegionId}/${d.DiskId}`,
      d.DiskName || d.DiskId,
      {
        name: d.DiskName ?? "",
        description: d.Description ?? "",
        region: d.RegionId,
        zoneId: d.ZoneId ?? "",
        sizeGb: d.Size,
        category: d.Category ?? "",
        performanceLevel: d.PerformanceLevel ?? "",
        diskType: d.Type ?? "",
        status: d.Status ?? "",
        instanceId: d.InstanceId ?? "",
        deleteWithInstance: d.DeleteWithInstance,
        encrypted: d.Encrypted,
        chargeType: d.DiskChargeType ?? "",
        createdAt: d.CreationTime ?? "",
      },
      { id: d.DiskId },
      { createdAt: d.CreationTime },
    ),
  );
}

interface EcsSnapshot {
  SnapshotId: string;
  SnapshotName?: string;
  Description?: string;
  RegionId?: string;
  SourceDiskId?: string;
  SourceDiskSize?: string;
  Status?: string;
  Progress?: string;
  RetentionDays?: number;
  SnapshotType?: string;
  CreationTime?: string;
}

export async function listSnapshots(ctx: ListContext): Promise<ResourceInstance[]> {
  const all = await perRegion(ctx.inventory, "ecs", ctx.regionHint, async (region) => {
    const items = await nextTokens(async (token) => {
      const res = await ctx.api.rpc<{
        Snapshots?: { Snapshot?: EcsSnapshot[] };
        NextToken?: string;
      }>("ecs", region, "DescribeSnapshots", {
        RegionId: region,
        MaxResults: 100,
        NextToken: token,
      });
      return { items: res.Snapshots?.Snapshot ?? [], next: res.NextToken };
    });
    return items.map((s) => ({ ...s, RegionId: s.RegionId ?? region }));
  });
  return all.map((s) =>
    makeResource(
      ctx.accountId,
      "snapshot",
      `${s.RegionId}/${s.SnapshotId}`,
      s.SnapshotName || s.SnapshotId,
      {
        name: s.SnapshotName ?? "",
        description: s.Description ?? "",
        region: s.RegionId ?? "",
        sourceDiskId: s.SourceDiskId ?? "",
        sizeGb: s.SourceDiskSize ? Number(s.SourceDiskSize) : undefined,
        status: s.Status ?? "",
        progress: s.Progress ?? "",
        retentionDays: s.RetentionDays || undefined,
        snapshotType: s.SnapshotType ?? "",
        createdAt: s.CreationTime ?? "",
      },
      { id: s.SnapshotId },
      { createdAt: s.CreationTime },
    ),
  );
}

interface SecurityGroup {
  SecurityGroupId: string;
  SecurityGroupName?: string;
  Description?: string;
  VpcId?: string;
  SecurityGroupType?: string;
  EcsCount?: number;
  RuleCount?: number;
  CreationTime?: string;
}

export interface SgPermission {
  Direction?: string;
  IpProtocol?: string;
  PortRange?: string;
  SourceCidrIp?: string;
  Ipv6SourceCidrIp?: string;
  Policy?: string;
  Priority?: string;
  Description?: string;
}

/** Summarise ingress rules: ports open to the internet and whether SSH/RDP is among them. */
export function analyseRules(perms: SgPermission[]): {
  ingress: string;
  openPorts: string;
  adminOpen: boolean;
} {
  const ingress = perms.filter((p) => (p.Direction ?? "ingress").toLowerCase() === "ingress");
  const open: string[] = [];
  let adminOpen = false;
  for (const p of ingress) {
    if ((p.Policy ?? "Accept").toLowerCase() !== "accept") continue;
    const world = p.SourceCidrIp === "0.0.0.0/0" || p.Ipv6SourceCidrIp === "::/0";
    if (!world) continue;
    const proto = (p.IpProtocol ?? "").toUpperCase();
    if (proto !== "TCP" && proto !== "ALL") continue;
    const [fromRaw, toRaw] = (p.PortRange ?? "-1/-1").split("/");
    const from = Number(fromRaw);
    const to = Number(toRaw);
    if (proto === "ALL" || from === -1 || (from <= 1 && to >= 65535)) {
      open.push("all");
      adminOpen = true;
      continue;
    }
    open.push(from === to ? String(from) : `${from}-${to}`);
    if ((from <= 22 && to >= 22) || (from <= 3389 && to >= 3389)) adminOpen = true;
  }
  const ingressText = ingress
    .map(
      (p) =>
        `${p.Policy ?? "Accept"} ${p.IpProtocol ?? ""} ${p.PortRange ?? ""} from ${p.SourceCidrIp || p.Ipv6SourceCidrIp || "group"}`,
    )
    .join("; ");
  return { ingress: ingressText, openPorts: [...new Set(open)].join(", "), adminOpen };
}

export async function listSecurityGroups(ctx: ListContext): Promise<ResourceInstance[]> {
  const all = await perRegion(ctx.inventory, "ecs", ctx.regionHint, async (region) => {
    const groups = await nextTokens(async (token) => {
      const res = await ctx.api.rpc<{
        SecurityGroups?: { SecurityGroup?: SecurityGroup[] };
        NextToken?: string;
      }>("ecs", region, "DescribeSecurityGroups", {
        RegionId: region,
        MaxResults: 100,
        NextToken: token,
      });
      return { items: res.SecurityGroups?.SecurityGroup ?? [], next: res.NextToken };
    });
    return mapLimit(groups, 4, async (g) => {
      const rules = await ctx.api
        .rpc<{ Permissions?: { Permission?: SgPermission[] } }>(
          "ecs",
          region,
          "DescribeSecurityGroupAttribute",
          { RegionId: region, SecurityGroupId: g.SecurityGroupId, Direction: "ingress" },
        )
        .then((r) => r.Permissions?.Permission ?? [])
        .catch(() => null);
      return { g, region, rules };
    });
  });
  return all.map(({ g, region, rules }) => {
    const analysis = rules ? analyseRules(rules) : null;
    return makeResource(
      ctx.accountId,
      "security-group",
      `${region}/${g.SecurityGroupId}`,
      g.SecurityGroupName || g.SecurityGroupId,
      {
        name: g.SecurityGroupName ?? "",
        description: g.Description ?? "",
        region,
        vpcId: g.VpcId ?? "",
        groupType: g.SecurityGroupType ?? "",
        ruleCount: g.RuleCount,
        instanceCount: g.EcsCount,
        ...(analysis
          ? {
              ingressRules: analysis.ingress,
              internetOpenPorts: analysis.openPorts,
              adminPortsOpen: analysis.adminOpen,
            }
          : {}),
        createdAt: g.CreationTime ?? "",
      },
      { id: g.SecurityGroupId },
      { createdAt: g.CreationTime },
    );
  });
}

// ---------------------------------------------------------------------------
// VPC

export async function listVpcs(ctx: ListContext): Promise<ResourceInstance[]> {
  interface Vpc {
    VpcId: string;
    VpcName?: string;
    Description?: string;
    RegionId?: string;
    CidrBlock?: string;
    IsDefault?: boolean;
    Status?: string;
    CreationTime?: string;
    VSwitchIds?: { VSwitchId?: string[] };
  }
  const all = await perRegion(ctx.inventory, "vpc", ctx.regionHint, async (region) => {
    const items = await pageNumbers(50, async (page) => {
      const res = await ctx.api.rpc<{ Vpcs?: { Vpc?: Vpc[] }; TotalCount?: number }>(
        "vpc",
        region,
        "DescribeVpcs",
        { RegionId: region, PageNumber: page, PageSize: 50 },
      );
      return { items: res.Vpcs?.Vpc ?? [], total: res.TotalCount };
    });
    return items.map((v) => ({ ...v, RegionId: v.RegionId ?? region }));
  });
  return all.map((v) =>
    makeResource(
      ctx.accountId,
      "vpc",
      `${v.RegionId}/${v.VpcId}`,
      v.VpcName || v.VpcId,
      {
        name: v.VpcName ?? "",
        description: v.Description ?? "",
        region: v.RegionId ?? "",
        cidrBlock: v.CidrBlock ?? "",
        isDefault: v.IsDefault,
        vswitchCount: v.VSwitchIds?.VSwitchId?.length,
        status: v.Status ?? "",
        createdAt: v.CreationTime ?? "",
      },
      { id: v.VpcId },
      { createdAt: v.CreationTime },
    ),
  );
}

export async function listVSwitches(ctx: ListContext): Promise<ResourceInstance[]> {
  interface VSwitch {
    VSwitchId: string;
    VSwitchName?: string;
    Description?: string;
    VpcId?: string;
    ZoneId?: string;
    CidrBlock?: string;
    AvailableIpAddressCount?: number;
    Status?: string;
    CreationTime?: string;
  }
  const all = await perRegion(ctx.inventory, "vpc", ctx.regionHint, async (region) => {
    const items = await pageNumbers(50, async (page) => {
      const res = await ctx.api.rpc<{ VSwitches?: { VSwitch?: VSwitch[] }; TotalCount?: number }>(
        "vpc",
        region,
        "DescribeVSwitches",
        { RegionId: region, PageNumber: page, PageSize: 50 },
      );
      return { items: res.VSwitches?.VSwitch ?? [], total: res.TotalCount };
    });
    return items.map((s) => ({ s, region }));
  });
  return all.map(({ s, region }) =>
    makeResource(
      ctx.accountId,
      "vswitch",
      `${region}/${s.VSwitchId}`,
      s.VSwitchName || s.VSwitchId,
      {
        name: s.VSwitchName ?? "",
        description: s.Description ?? "",
        region,
        zoneId: s.ZoneId ?? "",
        vpcId: s.VpcId ?? "",
        cidrBlock: s.CidrBlock ?? "",
        availableIps: s.AvailableIpAddressCount,
        status: s.Status ?? "",
        createdAt: s.CreationTime ?? "",
      },
      { id: s.VSwitchId },
      { createdAt: s.CreationTime },
    ),
  );
}

export async function listEips(ctx: ListContext): Promise<ResourceInstance[]> {
  interface Eip {
    AllocationId: string;
    Name?: string;
    IpAddress?: string;
    Bandwidth?: string;
    Status?: string;
    InstanceId?: string;
    InstanceType?: string;
    InternetChargeType?: string;
    ChargeType?: string;
    AllocationTime?: string;
  }
  const all = await perRegion(ctx.inventory, "vpc", ctx.regionHint, async (region) => {
    const items = await pageNumbers(100, async (page) => {
      const res = await ctx.api.rpc<{
        EipAddresses?: { EipAddress?: Eip[] };
        TotalCount?: number;
      }>("vpc", region, "DescribeEipAddresses", {
        RegionId: region,
        PageNumber: page,
        PageSize: 100,
      });
      return { items: res.EipAddresses?.EipAddress ?? [], total: res.TotalCount };
    });
    return items.map((e) => ({ e, region }));
  });
  return all.map(({ e, region }) =>
    makeResource(
      ctx.accountId,
      "eip",
      `${region}/${e.AllocationId}`,
      e.Name || e.IpAddress || e.AllocationId,
      {
        name: e.Name ?? "",
        region,
        ipAddress: e.IpAddress ?? "",
        bandwidthMbps: e.Bandwidth ? Number(e.Bandwidth) : undefined,
        status: e.Status ?? "",
        instanceId: e.InstanceId ?? "",
        instanceType: e.InstanceType ?? "",
        internetChargeType: e.InternetChargeType ?? "",
        chargeType: e.ChargeType ?? "",
        createdAt: e.AllocationTime ?? "",
      },
      { ipAddress: e.IpAddress, id: e.AllocationId },
      { createdAt: e.AllocationTime },
    ),
  );
}

// ---------------------------------------------------------------------------
// Load balancers

export async function listSlbs(ctx: ListContext): Promise<ResourceInstance[]> {
  interface Slb {
    LoadBalancerId: string;
    LoadBalancerName?: string;
    Address?: string;
    AddressType?: string;
    LoadBalancerSpec?: string;
    LoadBalancerStatus?: string;
    VpcId?: string;
    VSwitchId?: string;
    Bandwidth?: number;
    InternetChargeType?: string;
    PayType?: string;
    MasterZoneId?: string;
    CreateTime?: string;
  }
  const all = await perRegion(ctx.inventory, "slb", ctx.regionHint, async (region) => {
    const items = await pageNumbers(100, async (page) => {
      const res = await ctx.api.rpc<{
        LoadBalancers?: { LoadBalancer?: Slb[] };
        TotalCount?: number;
      }>("slb", region, "DescribeLoadBalancers", {
        RegionId: region,
        PageNumber: page,
        PageSize: 100,
      });
      return { items: res.LoadBalancers?.LoadBalancer ?? [], total: res.TotalCount };
    });
    return items.map((l) => ({ l, region }));
  });
  return all.map(({ l, region }) =>
    makeResource(
      ctx.accountId,
      "slb",
      `${region}/${l.LoadBalancerId}`,
      l.LoadBalancerName || l.LoadBalancerId,
      {
        name: l.LoadBalancerName ?? "",
        region,
        address: l.Address ?? "",
        addressType: l.AddressType ?? "",
        spec: l.LoadBalancerSpec ?? "",
        status: l.LoadBalancerStatus ?? "",
        vpcId: l.VpcId ?? "",
        vswitchId: l.VSwitchId ?? "",
        bandwidthMbps: l.Bandwidth,
        internetChargeType: l.InternetChargeType ?? "",
        chargeType: l.PayType ?? "",
        masterZoneId: l.MasterZoneId ?? "",
        createdAt: l.CreateTime ?? "",
      },
      { address: l.Address, id: l.LoadBalancerId },
      { createdAt: l.CreateTime },
    ),
  );
}

export async function listAlbs(ctx: ListContext): Promise<ResourceInstance[]> {
  interface Alb {
    LoadBalancerId: string;
    LoadBalancerName?: string;
    DNSName?: string;
    AddressType?: string;
    LoadBalancerEdition?: string;
    LoadBalancerStatus?: string;
    LoadBalancerBussinessStatus?: string;
    VpcId?: string;
    LoadBalancerBillingConfig?: { PayType?: string };
    CreateTime?: string;
  }
  const all = await perRegion(ctx.inventory, "alb", ctx.regionHint, async (region) => {
    const items = await nextTokens(async (token) => {
      const res = await ctx.api.rpc<{ LoadBalancers?: Alb[]; NextToken?: string }>(
        "alb",
        region,
        "ListLoadBalancers",
        { MaxResults: 100, NextToken: token },
      );
      return { items: res.LoadBalancers ?? [], next: res.NextToken };
    });
    return items.map((l) => ({ l, region }));
  });
  return all.map(({ l, region }) =>
    makeResource(
      ctx.accountId,
      "alb",
      `${region}/${l.LoadBalancerId}`,
      l.LoadBalancerName || l.LoadBalancerId,
      {
        name: l.LoadBalancerName ?? "",
        region,
        dnsName: l.DNSName ?? "",
        addressType: l.AddressType ?? "",
        edition: l.LoadBalancerEdition ?? "",
        status: l.LoadBalancerStatus ?? "",
        businessStatus: l.LoadBalancerBussinessStatus ?? "",
        vpcId: l.VpcId ?? "",
        payType: l.LoadBalancerBillingConfig?.PayType ?? "",
        createdAt: l.CreateTime ?? "",
      },
      { dnsName: l.DNSName, id: l.LoadBalancerId },
      { createdAt: l.CreateTime },
    ),
  );
}

// ---------------------------------------------------------------------------
// Databases

interface RdsAttribute {
  DBInstanceId: string;
  DBInstanceDescription?: string;
  RegionId?: string;
  ZoneId?: string;
  Engine?: string;
  EngineVersion?: string;
  DBInstanceClass?: string;
  DBInstanceStorage?: number;
  DBInstanceStorageType?: string;
  Category?: string;
  DBInstanceCPU?: string;
  DBInstanceMemory?: number;
  DBInstanceStatus?: string;
  PayType?: string;
  VpcId?: string;
  VSwitchId?: string;
  ExpireTime?: string;
  ConnectionString?: string;
  Port?: string;
  CreationTime?: string;
  CreateTime?: string;
}

export function mapRds(accountId: string, region: string, d: RdsAttribute): ResourceInstance {
  const created = d.CreationTime ?? d.CreateTime;
  return makeResource(
    accountId,
    "rds-instance",
    `${region}/${d.DBInstanceId}`,
    d.DBInstanceDescription || d.DBInstanceId,
    {
      name: d.DBInstanceDescription ?? "",
      region,
      zoneId: d.ZoneId ?? "",
      engine: d.Engine ?? "",
      engineVersion: d.EngineVersion ?? "",
      instanceClass: d.DBInstanceClass ?? "",
      storageGb: d.DBInstanceStorage,
      storageType: d.DBInstanceStorageType ?? "",
      category: d.Category ?? "",
      vcpus: d.DBInstanceCPU ? Number(d.DBInstanceCPU) : undefined,
      memoryMb: d.DBInstanceMemory,
      status: d.DBInstanceStatus ?? "",
      payType: d.PayType ?? "",
      vpcId: d.VpcId ?? "",
      vswitchId: d.VSwitchId ?? "",
      expireTime: d.PayType === "Prepaid" ? (d.ExpireTime ?? "") : "",
      createdAt: created ?? "",
    },
    { host: d.ConnectionString, port: d.Port, id: d.DBInstanceId },
    { createdAt: created },
  );
}

export async function rdsAttribute(
  api: AliApi,
  region: string,
  id: string,
): Promise<RdsAttribute | undefined> {
  const res = await api.rpc<{ Items?: { DBInstanceAttribute?: RdsAttribute[] } }>(
    "rds",
    region,
    "DescribeDBInstanceAttribute",
    { DBInstanceId: id },
  );
  return res.Items?.DBInstanceAttribute?.[0];
}

export async function listRds(ctx: ListContext): Promise<ResourceInstance[]> {
  const all = await perRegion(ctx.inventory, "rds", ctx.regionHint, async (region) => {
    const items = await pageNumbers(100, async (page) => {
      const res = await ctx.api.rpc<{
        Items?: { DBInstance?: RdsAttribute[] };
        TotalRecordCount?: number;
      }>("rds", region, "DescribeDBInstances", {
        RegionId: region,
        PageNumber: page,
        PageSize: 100,
      });
      return { items: res.Items?.DBInstance ?? [], total: res.TotalRecordCount };
    });
    // Storage and port are only on the attribute call.
    return mapLimit(items, 4, async (d) => {
      const attr = await rdsAttribute(ctx.api, region, d.DBInstanceId).catch(() => undefined);
      return { region, d: { ...d, ...(attr ?? {}) } };
    });
  });
  return all.map(({ region, d }) => mapRds(ctx.accountId, region, d));
}

interface RedisInstance {
  InstanceId: string;
  InstanceName?: string;
  ZoneId?: string;
  InstanceClass?: string;
  Capacity?: number;
  EngineVersion?: string;
  ArchitectureType?: string;
  InstanceType?: string;
  InstanceStatus?: string;
  ChargeType?: string;
  VpcId?: string;
  VSwitchId?: string;
  ConnectionDomain?: string;
  Port?: number;
  CreateTime?: string;
}

export function mapRedis(accountId: string, region: string, r: RedisInstance): ResourceInstance {
  return makeResource(
    accountId,
    "redis-instance",
    `${region}/${r.InstanceId}`,
    r.InstanceName || r.InstanceId,
    {
      name: r.InstanceName ?? "",
      region,
      zoneId: r.ZoneId ?? "",
      instanceClass: r.InstanceClass ?? "",
      capacityMb: r.Capacity,
      engineVersion: r.EngineVersion ?? "",
      architecture: r.ArchitectureType ?? "",
      instanceType: r.InstanceType ?? "",
      status: r.InstanceStatus ?? "",
      chargeType: r.ChargeType ?? "",
      vpcId: r.VpcId ?? "",
      vswitchId: r.VSwitchId ?? "",
      createdAt: r.CreateTime ?? "",
    },
    {
      host: r.ConnectionDomain,
      port: r.Port !== undefined ? String(r.Port) : undefined,
      id: r.InstanceId,
    },
    { createdAt: r.CreateTime },
  );
}

export async function listRedis(ctx: ListContext): Promise<ResourceInstance[]> {
  const all = await perRegion(ctx.inventory, "redis", ctx.regionHint, async (region) => {
    const items = await pageNumbers(50, async (page) => {
      const res = await ctx.api.rpc<{
        Instances?: { KVStoreInstance?: RedisInstance[] };
        TotalCount?: number;
      }>("redis", region, "DescribeInstances", {
        RegionId: region,
        PageNumber: page,
        PageSize: 50,
      });
      return { items: res.Instances?.KVStoreInstance ?? [], total: res.TotalCount };
    });
    return items.map((r) => ({ r, region }));
  });
  return all.map(({ r, region }) => mapRedis(ctx.accountId, region, r));
}

// ---------------------------------------------------------------------------
// OSS

export interface OssBucketSummary {
  name: string;
  region: string;
  storageClass: string;
  createdAt: string;
}

function xmlValues(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]!);
  return out;
}

export function xmlValue(xml: string, tag: string): string {
  return xmlValues(xml, tag)[0] ?? "";
}

/** Parse a ListBuckets (GetService) page. */
export function parseListBuckets(xml: string): {
  buckets: OssBucketSummary[];
  nextMarker: string;
  truncated: boolean;
} {
  const buckets = xmlValues(xml, "Bucket").map((b) => ({
    name: xmlValue(b, "Name"),
    region: xmlValue(b, "Region") || xmlValue(b, "Location").replace(/^oss-/, ""),
    storageClass: xmlValue(b, "StorageClass"),
    createdAt: xmlValue(b, "CreationDate"),
  }));
  return {
    buckets,
    nextMarker: xmlValue(xml, "NextMarker"),
    truncated: xmlValue(xml, "IsTruncated") === "true",
  };
}

/** ListBuckets is account-wide; any OSS region answers it. */
export async function listBucketSummaries(
  api: AliApi,
  homeRegion: string,
): Promise<OssBucketSummary[]> {
  const region = OSS_REGIONS.has(homeRegion) ? homeRegion : "ap-southeast-1";
  const out: OssBucketSummary[] = [];
  let marker = "";
  for (let i = 0; i < 50; i++) {
    const res = await api.oss({
      method: "GET",
      region,
      query: { "max-keys": "1000", ...(marker ? { marker } : {}) },
    });
    const page = parseListBuckets(res.body);
    out.push(...page.buckets);
    if (!page.truncated || !page.nextMarker) break;
    marker = page.nextMarker;
  }
  return out;
}

export async function bucketInfo(
  api: AliApi,
  region: string,
  bucket: string,
): Promise<{ acl: string; versioning: string; redundancy: string; storageClass: string }> {
  const res = await api.oss({ method: "GET", region, bucket, query: { bucketInfo: "" } });
  return {
    acl: xmlValue(res.body, "Grant"),
    versioning: xmlValue(res.body, "Versioning") || "Disabled",
    redundancy: xmlValue(res.body, "DataRedundancyType"),
    storageClass: xmlValue(res.body, "StorageClass"),
  };
}

export function mapBucket(
  accountId: string,
  b: OssBucketSummary,
  info?: { acl: string; versioning: string; redundancy: string },
): ResourceInstance {
  return makeResource(
    accountId,
    "oss-bucket",
    `${b.region}/${b.name}`,
    b.name,
    {
      name: b.name,
      region: b.region,
      storageClass: b.storageClass,
      ...(info
        ? { acl: info.acl, versioning: info.versioning, redundancyType: info.redundancy }
        : {}),
      createdAt: b.createdAt,
    },
    { name: b.name, endpoint: `${b.name}.${ossEndpoint(b.region)}` },
    { createdAt: b.createdAt },
  );
}

export async function listBuckets(ctx: ListContext): Promise<ResourceInstance[]> {
  const all = (await listBucketSummaries(ctx.api, ctx.inventory.homeRegion)).filter(
    (b) => !ctx.regionHint || b.region === ctx.regionHint,
  );
  return mapLimit(all, 6, async (b) => {
    const info = await bucketInfo(ctx.api, b.region, b.name).catch(() => undefined);
    return mapBucket(ctx.accountId, b, info);
  });
}

// ---------------------------------------------------------------------------
// ACK

interface AckCluster {
  cluster_id: string;
  name?: string;
  region_id?: string;
  cluster_type?: string;
  cluster_spec?: string;
  current_version?: string;
  next_version?: string;
  state?: string;
  size?: number;
  vpc_id?: string;
  master_url?: string;
  deletion_protection?: boolean;
  created?: string;
}

export function apiEndpointOf(masterUrl: string | undefined): string {
  if (!masterUrl) return "";
  try {
    const parsed = JSON.parse(masterUrl) as {
      api_server_endpoint?: string;
      intranet_api_server_endpoint?: string;
    };
    return parsed.api_server_endpoint || parsed.intranet_api_server_endpoint || "";
  } catch {
    return "";
  }
}

export function mapCluster(accountId: string, region: string, c: AckCluster): ResourceInstance {
  return makeResource(
    accountId,
    "ack-cluster",
    `${region}/${c.cluster_id}`,
    c.name || c.cluster_id,
    {
      name: c.name ?? "",
      region,
      clusterType: c.cluster_type ?? "",
      clusterSpec: c.cluster_spec ?? "",
      kubernetesVersion: c.current_version ?? "",
      nextVersion: c.next_version ?? "",
      status: c.state ?? "",
      nodeCount: c.size,
      vpcId: c.vpc_id ?? "",
      deletionProtection: c.deletion_protection,
      createdAt: c.created ?? "",
    },
    { apiEndpoint: apiEndpointOf(c.master_url), id: c.cluster_id },
    { createdAt: c.created },
  );
}

async function clustersIn(api: AliApi, region: string): Promise<AckCluster[]> {
  return pageNumbers(100, async (page) => {
    const res = await api.roa<{
      clusters?: AckCluster[];
      page_info?: { total_count?: number };
    }>({
      product: "cs",
      region,
      action: "DescribeClustersV1",
      method: "GET",
      path: "/api/v1/clusters",
      query: { region_id: region, page_size: 100, page_number: page },
    });
    return { items: res.clusters ?? [], total: res.page_info?.total_count };
  });
}

export async function listClusters(ctx: ListContext): Promise<ResourceInstance[]> {
  const all = await perRegion(ctx.inventory, "cs", ctx.regionHint, async (region) =>
    (await clustersIn(ctx.api, region)).map((c) => ({ c, region })),
  );
  return all.map(({ c, region }) => mapCluster(ctx.accountId, region, c));
}

interface NodePool {
  nodepool_info?: { nodepool_id?: string; name?: string; created?: string };
  status?: { state?: string; total_nodes?: number; healthy_nodes?: number };
  auto_scaling?: { enable?: boolean };
  scaling_group?: { desired_size?: number; instance_types?: string[] };
}

export async function nodePoolsOf(
  ctx: ListContext,
  region: string,
  clusterId: string,
): Promise<ResourceInstance[]> {
  const res = await ctx.api.roa<{ nodepools?: NodePool[] }>({
    product: "cs",
    region,
    action: "DescribeClusterNodePools",
    method: "GET",
    path: `/clusters/${clusterId}/nodepools`,
  });
  return (res.nodepools ?? [])
    .filter((p) => p.nodepool_info?.nodepool_id)
    .map((p) =>
      makeResource(
        ctx.accountId,
        "ack-node-pool",
        `${region}/${clusterId}/${p.nodepool_info!.nodepool_id}`,
        p.nodepool_info?.name || p.nodepool_info!.nodepool_id!,
        {
          name: p.nodepool_info?.name ?? "",
          region,
          clusterId,
          desiredSize: p.scaling_group?.desired_size,
          totalNodes: p.status?.total_nodes,
          healthyNodes: p.status?.healthy_nodes,
          instanceTypes: join(p.scaling_group?.instance_types),
          autoScaling: p.auto_scaling?.enable,
          status: p.status?.state ?? "",
        },
        { id: p.nodepool_info!.nodepool_id },
        {
          createdAt: p.nodepool_info?.created,
          parentExternalId: { typeId: "ack-cluster", id: `${region}/${clusterId}` },
        },
      ),
    );
}

export async function listNodePools(ctx: ListContext): Promise<ResourceInstance[]> {
  const all = await perRegion(ctx.inventory, "cs", ctx.regionHint, async (region) => {
    const clusters = await clustersIn(ctx.api, region);
    const pools = await mapLimit(clusters, 4, (c) =>
      nodePoolsOf(ctx, region, c.cluster_id).catch((err: unknown) => {
        if (isPermissionGap(err)) return [] as ResourceInstance[];
        throw err;
      }),
    );
    return pools.flat();
  });
  return all;
}

// ---------------------------------------------------------------------------
// Function Compute 3.0

export interface FcFunction {
  functionName: string;
  description?: string;
  runtime?: string;
  handler?: string;
  memorySize?: number;
  cpu?: number;
  timeout?: number;
  state?: string;
  lastModifiedTime?: string;
  createdTime?: string;
  functionArn?: string;
}

export function mapFunction(accountId: string, region: string, fn: FcFunction): ResourceInstance {
  return makeResource(
    accountId,
    "fc-function",
    `${region}/${fn.functionName}`,
    fn.functionName,
    {
      name: fn.functionName,
      description: fn.description ?? "",
      region,
      runtime: fn.runtime ?? "",
      handler: fn.handler ?? "",
      memoryMb: fn.memorySize,
      cpu: fn.cpu,
      timeoutSeconds: fn.timeout,
      state: fn.state ?? "",
      lastModified: fn.lastModifiedTime ?? "",
      createdAt: fn.createdTime ?? "",
    },
    { arn: fn.functionArn },
    { createdAt: fn.createdTime },
  );
}

export async function listFunctions(ctx: ListContext): Promise<ResourceInstance[]> {
  const all = await perRegion(ctx.inventory, "fc", ctx.regionHint, async (region) => {
    const items = await nextTokens(async (token) => {
      const res = await ctx.api.roa<{ functions?: FcFunction[]; nextToken?: string }>({
        product: "fc",
        region,
        action: "ListFunctions",
        method: "GET",
        path: "/2023-03-30/functions",
        query: { limit: 100, nextToken: token },
      });
      return { items: res.functions ?? [], next: res.nextToken };
    });
    return items.map((fn) => ({ fn, region }));
  });
  return all.map(({ fn, region }) => mapFunction(ctx.accountId, region, fn));
}

/** The function's HTTP trigger URL, when it has one. */
export async function functionHttpUrl(api: AliApi, region: string, name: string): Promise<string> {
  const res = await api.roa<{
    triggers?: Array<{ triggerType?: string; httpTrigger?: { urlInternet?: string } }>;
  }>({
    product: "fc",
    region,
    action: "ListTriggers",
    method: "GET",
    path: `/2023-03-30/functions/${name}/triggers`,
    query: { limit: 100 },
  });
  return (
    (res.triggers ?? []).find((t) => t.httpTrigger?.urlInternet)?.httpTrigger?.urlInternet ?? ""
  );
}

// ---------------------------------------------------------------------------
// Alidns

interface DnsDomain {
  DomainId?: string;
  DomainName: string;
  RecordCount?: number;
  DnsServers?: { DnsServer?: string[] };
  VersionName?: string;
  Remark?: string;
  CreateTime?: string;
}

export async function describeDomains(api: AliApi): Promise<DnsDomain[]> {
  return pageNumbers(100, async (page) => {
    const res = await api.rpc<{ Domains?: { Domain?: DnsDomain[] }; TotalCount?: number }>(
      "alidns",
      "",
      "DescribeDomains",
      { PageNumber: page, PageSize: 100, Lang: "en" },
    );
    return { items: res.Domains?.Domain ?? [], total: res.TotalCount };
  });
}

export async function listDomains(ctx: ListContext): Promise<ResourceInstance[]> {
  const domains = await describeDomains(ctx.api);
  return domains.map((d) =>
    makeResource(
      ctx.accountId,
      "dns-domain",
      d.DomainName,
      d.DomainName,
      {
        name: d.DomainName,
        recordCount: d.RecordCount,
        nameservers: join(d.DnsServers?.DnsServer),
        edition: d.VersionName ?? "",
        remark: d.Remark ?? "",
        createdAt: d.CreateTime ?? "",
      },
      { nameservers: join(d.DnsServers?.DnsServer), id: d.DomainId },
      { createdAt: d.CreateTime },
    ),
  );
}

export interface DnsRecord {
  RecordId: string;
  RR?: string;
  Type?: string;
  Value?: string;
  TTL?: number;
  Priority?: number;
  Line?: string;
  Status?: string;
  DomainName?: string;
}

export function mapRecord(accountId: string, domain: string, r: DnsRecord): ResourceInstance {
  return makeResource(
    accountId,
    "dns-record",
    `${domain}/${r.RecordId}`,
    `${r.RR ?? "@"} ${r.Type ?? ""}`.trim(),
    {
      name: r.RR ?? "@",
      type: r.Type ?? "",
      content: r.Value ?? "",
      ttl: r.TTL,
      priority: r.Type === "MX" ? r.Priority : undefined,
      line: r.Line ?? "",
      status: r.Status ?? "",
      domain,
    },
    {},
    { parentExternalId: { typeId: "dns-domain", id: domain } },
  );
}

export async function recordsOf(ctx: ListContext, domain: string): Promise<ResourceInstance[]> {
  const items = await pageNumbers(500, async (page) => {
    const res = await ctx.api.rpc<{
      DomainRecords?: { Record?: DnsRecord[] };
      TotalCount?: number;
    }>("alidns", "", "DescribeDomainRecords", {
      DomainName: domain,
      PageNumber: page,
      PageSize: 500,
      Lang: "en",
    });
    return { items: res.DomainRecords?.Record ?? [], total: res.TotalCount };
  });
  return items.map((r) => mapRecord(ctx.accountId, domain, r));
}

export async function listRecords(ctx: ListContext): Promise<ResourceInstance[]> {
  const domains = await describeDomains(ctx.api);
  return (await mapLimit(domains, 4, (d) => recordsOf(ctx, d.DomainName))).flat();
}

// ---------------------------------------------------------------------------
// RAM

interface RamUser {
  UserName: string;
  UserId?: string;
  DisplayName?: string;
  Email?: string;
  Comments?: string;
  CreateDate?: string;
  LastLoginDate?: string;
}

export async function ramUserResource(ctx: ListContext, u: RamUser): Promise<ResourceInstance> {
  const [keys, policies, full] = await Promise.all([
    ctx.api
      .rpc<{ AccessKeys?: { AccessKey?: Array<{ AccessKeyId: string; Status?: string }> } }>(
        "ram",
        "",
        "ListAccessKeys",
        { UserName: u.UserName },
      )
      .then((r) => r.AccessKeys?.AccessKey ?? [])
      .catch(() => null),
    ctx.api
      .rpc<{ Policies?: { Policy?: Array<{ PolicyName: string }> } }>(
        "ram",
        "",
        "ListPoliciesForUser",
        { UserName: u.UserName },
      )
      .then((r) => (r.Policies?.Policy ?? []).map((p) => p.PolicyName))
      .catch(() => null),
    ctx.api
      .rpc<{ User?: RamUser }>("ram", "", "GetUser", { UserName: u.UserName })
      .then((r) => r.User)
      .catch(() => undefined),
  ]);
  const user = { ...u, ...(full ?? {}) };
  return makeResource(
    ctx.accountId,
    "ram-user",
    user.UserName,
    user.DisplayName || user.UserName,
    {
      name: user.UserName,
      displayName: user.DisplayName ?? "",
      email: user.Email ?? "",
      comments: user.Comments ?? "",
      userId: user.UserId ?? "",
      ...(keys
        ? {
            accessKeys: keys.map((k) => `${k.AccessKeyId} (${k.Status ?? "?"})`).join(", "),
            activeKeyCount: keys.filter((k) => k.Status === "Active").length,
          }
        : {}),
      ...(policies
        ? { policies: policies.join(", "), isAdmin: policies.includes("AdministratorAccess") }
        : {}),
      lastLoginAt: user.LastLoginDate ?? "",
      createdAt: user.CreateDate ?? "",
    },
    { userId: user.UserId },
    { createdAt: user.CreateDate },
  );
}

export async function listRamUsers(ctx: ListContext): Promise<ResourceInstance[]> {
  const users: RamUser[] = [];
  let marker: string | undefined;
  for (let i = 0; i < 50; i++) {
    const res = await ctx.api.rpc<{
      Users?: { User?: RamUser[] };
      IsTruncated?: boolean;
      Marker?: string;
    }>("ram", "", "ListUsers", { MaxItems: 1000, Marker: marker });
    users.push(...(res.Users?.User ?? []));
    if (!res.IsTruncated || !res.Marker) break;
    marker = res.Marker;
  }
  return mapLimit(users, 4, (u) => ramUserResource(ctx, u));
}
