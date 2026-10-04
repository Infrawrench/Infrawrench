import type { ResourceInstance } from "@infrawrench/plugin-base";
import { isAuthorizationGap, type OciApi } from "./api.js";
import { mapLimit, type OciInventory, type Scope, type SearchType } from "./inventory.js";

/**
 * Listers: one per resource type, each returning `ResourceInstance`s with
 * outputs already resolved, so the detail page and pickers need no second
 * round trip. Every lister fans out over `inventory.scopes()`, and a scope
 * the credential is not authorised for lists empty rather than failing the
 * whole type: OCI policies are granted per compartment, so a user who can
 * see three compartments of ten is normal, not an error.
 */

export const PLUGIN_ID = "oracle-cloud";
const CONCURRENCY = 6;

export interface ListContext {
  api: OciApi;
  inventory: OciInventory;
  accountId: string;
  regionHint?: string;
}

export function makeResource(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, string | number | boolean>,
  resolvedOutputs: Record<string, string> = {},
  extra: { createdAt?: string; parentResourceId?: string } = {},
): ResourceInstance {
  const created = extra.createdAt ?? new Date(0).toISOString();
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields,
    resolvedOutputs,
    secretStates: [],
    externalId,
    createdAt: created,
    updatedAt: created,
    ...(extra.parentResourceId ? { parentResourceId: extra.parentResourceId } : {}),
  };
}

/** Run a per-scope lister, treating authorisation gaps as empty scopes. */
async function perScope<T>(
  ctx: ListContext,
  type: SearchType,
  fn: (scope: Scope) => Promise<T[]>,
): Promise<T[]> {
  const scopes = await ctx.inventory.scopes(type, ctx.regionHint);
  const results = await mapLimit(scopes, CONCURRENCY, async (scope) => {
    try {
      return await fn(scope);
    } catch (err) {
      if (isAuthorizationGap(err)) return [];
      throw err;
    }
  });
  return results.flat();
}

async function compartmentNames(ctx: ListContext): Promise<Map<string, string>> {
  const all = await ctx.inventory.compartments().catch(() => []);
  return new Map(all.map((c) => [c.id, c.name]));
}

const ALIVE = (state: string | undefined) => state !== "TERMINATED" && state !== "DELETED";

// ---------------------------------------------------------------------------
// Tenancy + compartments

export async function listTenancy(ctx: ListContext): Promise<ResourceInstance[]> {
  const [tenancy, regions] = await Promise.all([
    ctx.api.get<{ id: string; name: string; description?: string }>(
      "identity",
      ctx.inventory.homeRegion,
      `/20160918/tenancies/${ctx.api.tenancyOcid}`,
    ),
    ctx.inventory.regions().catch(() => [ctx.inventory.homeRegion]),
  ]);
  const home = await ctx.inventory.actualHomeRegion().catch(() => ctx.inventory.homeRegion);
  return [
    makeResource(
      ctx.accountId,
      "tenancy",
      tenancy.id,
      tenancy.name,
      {
        name: tenancy.name,
        homeRegion: home,
        subscribedRegions: regions.join(", "),
        description: tenancy.description ?? "",
      },
      { id: tenancy.id },
    ),
  ];
}

export async function listCompartments(ctx: ListContext): Promise<ResourceInstance[]> {
  const all = await ctx.inventory.compartments();
  return all
    .filter((c) => c.id !== ctx.api.tenancyOcid)
    .map((c) =>
      makeResource(
        ctx.accountId,
        "compartment",
        c.id,
        c.name,
        {
          name: c.name,
          description: c.description,
          parentId: c.parentId,
          path: c.path,
          status: c.lifecycleState,
        },
        { id: c.id },
        c.timeCreated ? { createdAt: c.timeCreated } : {},
      ),
    );
}

// ---------------------------------------------------------------------------
// Compute

export interface OciInstance {
  id: string;
  displayName: string;
  compartmentId: string;
  availabilityDomain: string;
  faultDomain?: string;
  region: string;
  shape: string;
  shapeConfig?: {
    ocpus?: number;
    memoryInGBs?: number;
    vcpus?: number;
    processorDescription?: string;
  };
  imageId?: string;
  sourceDetails?: { sourceType?: string; imageId?: string; bootVolumeId?: string };
  lifecycleState: string;
  timeCreated?: string;
}

interface OciVnicAttachment {
  instanceId: string;
  vnicId?: string;
  subnetId?: string;
  nicIndex?: number;
  lifecycleState: string;
}

interface OciVnic {
  publicIp?: string;
  privateIp?: string;
  isPrimary?: boolean;
}

interface OciImage {
  displayName?: string;
  operatingSystem?: string;
  operatingSystemVersion?: string;
}

/** Shapes OCI keeps billing for compute while stopped (stopped-instance billing doc). */
export function billedWhenStopped(shape: string): boolean {
  if (/DenseIO|HPC|^BM\.(?!Standard)/i.test(shape)) return true;
  if (/GPU/i.test(shape)) return !/GPU\.A10/i.test(shape);
  return false;
}

/** Login user for OCI platform images: `ubuntu` on Ubuntu, `opc` elsewhere. */
export function sshUserForImage(image: OciImage | undefined): string {
  const os = `${image?.operatingSystem ?? ""} ${image?.displayName ?? ""}`.toLowerCase();
  return os.includes("ubuntu") ? "ubuntu" : "opc";
}

/** Composite size id: `shape/ocpus/memoryGB` for flex shapes, the bare shape otherwise. */
export function sizeIdFor(shape: string, ocpus?: number, memoryGb?: number): string {
  if (/\.Flex$/i.test(shape) && ocpus !== undefined && memoryGb !== undefined) {
    return `${shape}/${trimNumber(ocpus)}/${trimNumber(memoryGb)}`;
  }
  return shape;
}

export function parseSizeId(size: string): { shape: string; ocpus?: number; memoryGb?: number } {
  const [shape, ocpus, memory] = size.split("/");
  if (ocpus !== undefined && memory !== undefined) {
    return { shape: shape!, ocpus: Number(ocpus), memoryGb: Number(memory) };
  }
  return { shape: shape! };
}

function trimNumber(n: number): string {
  return String(Number(n.toFixed(2)));
}

const imageCache = new Map<string, Promise<OciImage | undefined>>();

async function imageInfo(
  api: OciApi,
  region: string,
  imageId: string,
): Promise<OciImage | undefined> {
  const key = imageId;
  if (!imageCache.has(key)) {
    imageCache.set(
      key,
      api.get<OciImage>("iaas", region, `/20160918/images/${imageId}`).catch(() => undefined),
    );
  }
  return imageCache.get(key);
}

export async function mapInstance(
  ctx: ListContext,
  inst: OciInstance,
  names: Map<string, string>,
  network: { vnic?: OciVnic; subnetId?: string },
  bootVolumeId: string,
): Promise<ResourceInstance> {
  const imageId = inst.imageId ?? inst.sourceDetails?.imageId ?? "";
  const image = imageId ? await imageInfo(ctx.api, inst.region, imageId) : undefined;
  const cfg = inst.shapeConfig ?? {};
  return makeResource(
    ctx.accountId,
    "instance",
    inst.id,
    inst.displayName,
    {
      name: inst.displayName,
      region: inst.region,
      availabilityDomain: inst.availabilityDomain,
      faultDomain: inst.faultDomain ?? "",
      compartmentId: inst.compartmentId,
      compartmentName: names.get(inst.compartmentId) ?? "",
      size: sizeIdFor(inst.shape, cfg.ocpus, cfg.memoryInGBs),
      shape: inst.shape,
      ...(cfg.ocpus !== undefined ? { ocpus: cfg.ocpus } : {}),
      ...(cfg.memoryInGBs !== undefined ? { memoryGb: cfg.memoryInGBs } : {}),
      ...(cfg.vcpus !== undefined ? { vcpus: cfg.vcpus } : {}),
      processor: cfg.processorDescription ?? "",
      status: inst.lifecycleState,
      imageName: image?.displayName ?? "",
      imageId,
      subnetId: network.subnetId ?? "",
      bootVolumeId,
      billedWhenStopped: billedWhenStopped(inst.shape),
      sshUsername: sshUserForImage(image),
      timeCreated: inst.timeCreated ?? "",
    },
    {
      publicIp: network.vnic?.publicIp ?? "",
      privateIp: network.vnic?.privateIp ?? "",
      id: inst.id,
    },
    inst.timeCreated ? { createdAt: inst.timeCreated } : {},
  );
}

/** Primary VNIC and boot volume for every instance in one scope. */
async function instanceExtras(
  ctx: ListContext,
  scope: Scope,
  instances: OciInstance[],
): Promise<{
  network: Map<string, { vnic?: OciVnic; subnetId?: string }>;
  boot: Map<string, string>;
}> {
  const network = new Map<string, { vnic?: OciVnic; subnetId?: string }>();
  const boot = new Map<string, string>();
  if (instances.length === 0) return { network, boot };
  const attachments = await ctx.api
    .listAll<OciVnicAttachment>({
      service: "iaas",
      region: scope.region,
      path: "/20160918/vnicAttachments",
      query: { compartmentId: scope.compartmentId, limit: 1000 },
    })
    .catch(() => [] as OciVnicAttachment[]);
  const primary = new Map<string, OciVnicAttachment>();
  for (const a of attachments) {
    if (a.lifecycleState !== "ATTACHED") continue;
    const prev = primary.get(a.instanceId);
    if (!prev || (a.nicIndex ?? 0) < (prev.nicIndex ?? 0)) primary.set(a.instanceId, a);
  }
  await mapLimit([...primary.values()], CONCURRENCY, async (a) => {
    const vnic = a.vnicId
      ? await ctx.api
          .get<OciVnic>("iaas", scope.region, `/20160918/vnics/${a.vnicId}`)
          .catch(() => undefined)
      : undefined;
    network.set(a.instanceId, {
      ...(vnic ? { vnic } : {}),
      ...(a.subnetId ? { subnetId: a.subnetId } : {}),
    });
  });
  const ads = [...new Set(instances.map((i) => i.availabilityDomain))];
  await mapLimit(ads, CONCURRENCY, async (ad) => {
    const rows = await ctx.api
      .listAll<{ instanceId: string; bootVolumeId: string; lifecycleState: string }>({
        service: "iaas",
        region: scope.region,
        path: "/20160918/bootVolumeAttachments",
        query: { availabilityDomain: ad, compartmentId: scope.compartmentId, limit: 1000 },
      })
      .catch(() => []);
    for (const r of rows)
      if (r.lifecycleState === "ATTACHED") boot.set(r.instanceId, r.bootVolumeId);
  });
  return { network, boot };
}

export async function listInstances(ctx: ListContext): Promise<ResourceInstance[]> {
  const names = await compartmentNames(ctx);
  return perScope(ctx, "instance", async (scope) => {
    const instances = (
      await ctx.api.listAll<OciInstance>({
        service: "iaas",
        region: scope.region,
        path: "/20160918/instances",
        query: { compartmentId: scope.compartmentId, limit: 1000 },
      })
    ).filter((i) => ALIVE(i.lifecycleState));
    const { network, boot } = await instanceExtras(ctx, scope, instances);
    return Promise.all(
      instances.map((i) =>
        mapInstance(ctx, i, names, network.get(i.id) ?? {}, boot.get(i.id) ?? ""),
      ),
    );
  });
}

export async function getInstance(ctx: ListContext, ocid: string): Promise<ResourceInstance> {
  const region = await ctx.inventory.regionOfOcid(ocid);
  const inst = await ctx.api.get<OciInstance>("iaas", region, `/20160918/instances/${ocid}`);
  const names = await compartmentNames(ctx);
  const scope = { region: inst.region || region, compartmentId: inst.compartmentId };
  const attachments = await ctx.api
    .listAll<OciVnicAttachment>({
      service: "iaas",
      region: scope.region,
      path: "/20160918/vnicAttachments",
      query: { compartmentId: scope.compartmentId, instanceId: ocid },
    })
    .catch(() => [] as OciVnicAttachment[]);
  const primary = attachments
    .filter((a) => a.lifecycleState === "ATTACHED")
    .sort((a, b) => (a.nicIndex ?? 0) - (b.nicIndex ?? 0))[0];
  const vnic = primary?.vnicId
    ? await ctx.api
        .get<OciVnic>("iaas", scope.region, `/20160918/vnics/${primary.vnicId}`)
        .catch(() => undefined)
    : undefined;
  const bootRows = await ctx.api
    .listAll<{ bootVolumeId: string; lifecycleState: string }>({
      service: "iaas",
      region: scope.region,
      path: "/20160918/bootVolumeAttachments",
      query: {
        availabilityDomain: inst.availabilityDomain,
        compartmentId: scope.compartmentId,
        instanceId: ocid,
      },
    })
    .catch(() => []);
  return mapInstance(
    ctx,
    inst,
    names,
    { ...(vnic ? { vnic } : {}), ...(primary?.subnetId ? { subnetId: primary.subnetId } : {}) },
    bootRows.find((r) => r.lifecycleState === "ATTACHED")?.bootVolumeId ?? "",
  );
}

// ---------------------------------------------------------------------------
// Block storage

interface OciVolume {
  id: string;
  displayName: string;
  compartmentId: string;
  availabilityDomain: string;
  sizeInGBs?: number;
  vpusPerGB?: number;
  isAutoTuneEnabled?: boolean;
  lifecycleState: string;
  timeCreated?: string;
}

export async function listBlockVolumes(ctx: ListContext): Promise<ResourceInstance[]> {
  const names = await compartmentNames(ctx);
  return perScope(ctx, "volume", async (scope) => {
    const [volumes, attachments] = await Promise.all([
      ctx.api.listAll<OciVolume>({
        service: "iaas",
        region: scope.region,
        path: "/20160918/volumes",
        query: { compartmentId: scope.compartmentId, limit: 1000 },
      }),
      // Attachments live in the instance's compartment, which may differ
      // from the volume's: list them tenancy-wide per region would need
      // every compartment, so read the scope's own and the volume's.
      ctx.api
        .listAll<{ instanceId: string; volumeId: string; lifecycleState: string }>({
          service: "iaas",
          region: scope.region,
          path: "/20160918/volumeAttachments",
          query: { compartmentId: scope.compartmentId, limit: 1000 },
        })
        .catch(() => []),
    ]);
    const attached = new Map<string, string[]>();
    for (const a of attachments) {
      if (a.lifecycleState !== "ATTACHED" && a.lifecycleState !== "ATTACHING") continue;
      attached.set(a.volumeId, [...(attached.get(a.volumeId) ?? []), a.instanceId]);
    }
    return volumes
      .filter((v) => ALIVE(v.lifecycleState))
      .map((v) => mapVolume(ctx, "block-volume", scope.region, v, names, attached.get(v.id) ?? []));
  });
}

export function mapVolume(
  ctx: ListContext,
  typeId: "block-volume" | "boot-volume",
  region: string,
  v: OciVolume,
  names: Map<string, string>,
  attachedTo: string[],
): ResourceInstance {
  const base = {
    name: v.displayName,
    region,
    availabilityDomain: v.availabilityDomain,
    compartmentId: v.compartmentId,
    compartmentName: names.get(v.compartmentId) ?? "",
    sizeGb: v.sizeInGBs ?? 0,
    vpusPerGb: v.vpusPerGB ?? 10,
    status: v.lifecycleState,
  };
  const fields =
    typeId === "boot-volume"
      ? { ...base, attachedInstanceId: attachedTo[0] ?? "" }
      : { ...base, autoTune: v.isAutoTuneEnabled === true, attachedTo: attachedTo.join(", ") };
  return makeResource(
    ctx.accountId,
    typeId,
    v.id,
    v.displayName,
    fields,
    { id: v.id },
    v.timeCreated ? { createdAt: v.timeCreated } : {},
  );
}

export async function listBootVolumes(ctx: ListContext): Promise<ResourceInstance[]> {
  const names = await compartmentNames(ctx);
  return perScope(ctx, "bootvolume", async (scope) => {
    const ads = await ctx.inventory.availabilityDomains(scope.region);
    const perAd = await mapLimit(ads, CONCURRENCY, async (ad) => {
      const [volumes, attachments] = await Promise.all([
        ctx.api.listAll<OciVolume>({
          service: "iaas",
          region: scope.region,
          path: "/20160918/bootVolumes",
          query: { availabilityDomain: ad, compartmentId: scope.compartmentId, limit: 1000 },
        }),
        ctx.api
          .listAll<{ instanceId: string; bootVolumeId: string; lifecycleState: string }>({
            service: "iaas",
            region: scope.region,
            path: "/20160918/bootVolumeAttachments",
            query: { availabilityDomain: ad, compartmentId: scope.compartmentId, limit: 1000 },
          })
          .catch(() => []),
      ]);
      const attached = new Map<string, string>();
      for (const a of attachments) {
        if (a.lifecycleState === "ATTACHED" || a.lifecycleState === "ATTACHING") {
          attached.set(a.bootVolumeId, a.instanceId);
        }
      }
      return volumes
        .filter((v) => ALIVE(v.lifecycleState))
        .map((v) => {
          const instanceId = attached.get(v.id);
          return mapVolume(
            ctx,
            "boot-volume",
            scope.region,
            v,
            names,
            instanceId ? [instanceId] : [],
          );
        });
    });
    return perAd.flat();
  });
}

// ---------------------------------------------------------------------------
// Networking

interface OciVcn {
  id: string;
  displayName: string;
  compartmentId: string;
  cidrBlocks?: string[];
  cidrBlock?: string;
  dnsLabel?: string;
  vcnDomainName?: string;
  defaultSecurityListId?: string;
  lifecycleState: string;
  timeCreated?: string;
}

export async function listVcns(ctx: ListContext): Promise<ResourceInstance[]> {
  const names = await compartmentNames(ctx);
  return perScope(ctx, "vcn", async (scope) => {
    const vcns = await ctx.api.listAll<OciVcn>({
      service: "iaas",
      region: scope.region,
      path: "/20160918/vcns",
      query: { compartmentId: scope.compartmentId, limit: 1000 },
    });
    return vcns
      .filter((v) => ALIVE(v.lifecycleState))
      .map((v) =>
        makeResource(
          ctx.accountId,
          "vcn",
          v.id,
          v.displayName,
          {
            name: v.displayName,
            region: scope.region,
            compartmentId: v.compartmentId,
            compartmentName: names.get(v.compartmentId) ?? "",
            cidrBlocks: (v.cidrBlocks ?? (v.cidrBlock ? [v.cidrBlock] : [])).join(", "),
            dnsLabel: v.dnsLabel ?? "",
            domainName: v.vcnDomainName ?? "",
            defaultSecurityListId: v.defaultSecurityListId ?? "",
            status: v.lifecycleState,
          },
          { id: v.id },
          v.timeCreated ? { createdAt: v.timeCreated } : {},
        ),
      );
  });
}

interface OciSubnet {
  id: string;
  displayName: string;
  compartmentId: string;
  vcnId: string;
  cidrBlock: string;
  availabilityDomain?: string | null;
  prohibitPublicIpOnVnic?: boolean;
  securityListIds?: string[];
  dnsLabel?: string;
  lifecycleState: string;
  timeCreated?: string;
}

export async function listSubnets(ctx: ListContext): Promise<ResourceInstance[]> {
  const names = await compartmentNames(ctx);
  return perScope(ctx, "subnet", async (scope) => {
    const subnets = await ctx.api.listAll<OciSubnet>({
      service: "iaas",
      region: scope.region,
      path: "/20160918/subnets",
      query: { compartmentId: scope.compartmentId, limit: 1000 },
    });
    return subnets
      .filter((s) => ALIVE(s.lifecycleState))
      .map((s) =>
        makeResource(
          ctx.accountId,
          "subnet",
          s.id,
          s.displayName,
          {
            name: s.displayName,
            region: scope.region,
            compartmentId: s.compartmentId,
            compartmentName: names.get(s.compartmentId) ?? "",
            vcnId: s.vcnId,
            cidrBlock: s.cidrBlock,
            availabilityDomain: s.availabilityDomain ?? "",
            access: s.prohibitPublicIpOnVnic ? "private" : "public",
            securityListIds: (s.securityListIds ?? []).join(", "),
            dnsLabel: s.dnsLabel ?? "",
            status: s.lifecycleState,
          },
          { id: s.id },
          s.timeCreated ? { createdAt: s.timeCreated } : {},
        ),
      );
  });
}

interface PortRange {
  min: number;
  max: number;
}

export interface OciSecurityRule {
  protocol: string;
  source?: string;
  destination?: string;
  isStateless?: boolean;
  tcpOptions?: { destinationPortRange?: PortRange };
  udpOptions?: { destinationPortRange?: PortRange };
  description?: string;
}

const PROTOCOLS: Record<string, string> = {
  all: "all",
  "1": "ICMP",
  "6": "TCP",
  "17": "UDP",
  "58": "ICMPv6",
};

function describeRule(rule: OciSecurityRule, peer: string | undefined): string {
  const proto = PROTOCOLS[rule.protocol] ?? `proto ${rule.protocol}`;
  const range = rule.tcpOptions?.destinationPortRange ?? rule.udpOptions?.destinationPortRange;
  const ports = range
    ? range.min === range.max
      ? `:${range.min}`
      : `:${range.min}-${range.max}`
    : "";
  return `${proto}${ports} ${peer ?? "?"}${rule.isStateless ? " (stateless)" : ""}`;
}

/** TCP ports an ingress rule set opens to 0.0.0.0/0, as "22, 443" or "all". */
export function internetOpenPorts(rules: OciSecurityRule[]): string {
  const ports: string[] = [];
  for (const r of rules) {
    if (r.source !== "0.0.0.0/0") continue;
    if (r.protocol === "all") return "all";
    if (r.protocol !== "6") continue;
    const range = r.tcpOptions?.destinationPortRange;
    if (!range) return "all";
    ports.push(range.min === range.max ? String(range.min) : `${range.min}-${range.max}`);
  }
  return ports.join(", ");
}

export function adminPortsOpen(rules: OciSecurityRule[]): boolean {
  return rules.some((r) => {
    if (r.source !== "0.0.0.0/0") return false;
    if (r.protocol === "all") return true;
    if (r.protocol !== "6") return false;
    const range = r.tcpOptions?.destinationPortRange;
    if (!range) return true;
    return [22, 3389].some((p) => p >= range.min && p <= range.max);
  });
}

export async function listSecurityLists(ctx: ListContext): Promise<ResourceInstance[]> {
  const names = await compartmentNames(ctx);
  return perScope(ctx, "securitylist", async (scope) => {
    const lists = await ctx.api.listAll<{
      id: string;
      displayName: string;
      compartmentId: string;
      vcnId: string;
      ingressSecurityRules?: OciSecurityRule[];
      egressSecurityRules?: OciSecurityRule[];
      lifecycleState: string;
      timeCreated?: string;
    }>({
      service: "iaas",
      region: scope.region,
      path: "/20160918/securityLists",
      query: { compartmentId: scope.compartmentId, limit: 1000 },
    });
    return lists
      .filter((l) => ALIVE(l.lifecycleState))
      .map((l) => {
        const ingress = l.ingressSecurityRules ?? [];
        const egress = l.egressSecurityRules ?? [];
        return makeResource(
          ctx.accountId,
          "security-list",
          l.id,
          l.displayName,
          {
            name: l.displayName,
            region: scope.region,
            compartmentId: l.compartmentId,
            compartmentName: names.get(l.compartmentId) ?? "",
            vcnId: l.vcnId,
            ingressRules: ingress.map((r) => describeRule(r, r.source)).join("; "),
            egressRules: egress.map((r) => describeRule(r, r.destination)).join("; "),
            ingressRuleCount: ingress.length,
            egressRuleCount: egress.length,
            internetOpenPorts: internetOpenPorts(ingress),
            adminPortsOpen: adminPortsOpen(ingress),
            status: l.lifecycleState,
          },
          { id: l.id },
          l.timeCreated ? { createdAt: l.timeCreated } : {},
        );
      });
  });
}

export async function listReservedIps(ctx: ListContext): Promise<ResourceInstance[]> {
  const names = await compartmentNames(ctx);
  return perScope(ctx, "publicip", async (scope) => {
    const ips = await ctx.api.listAll<{
      id: string;
      displayName?: string;
      compartmentId: string;
      ipAddress: string;
      lifecycleState: string;
      assignedEntityId?: string;
      assignedEntityType?: string;
      timeCreated?: string;
    }>({
      service: "iaas",
      region: scope.region,
      path: "/20160918/publicIps",
      query: {
        scope: "REGION",
        lifetime: "RESERVED",
        compartmentId: scope.compartmentId,
        limit: 1000,
      },
    });
    return ips
      .filter((ip) => ALIVE(ip.lifecycleState))
      .map((ip) =>
        makeResource(
          ctx.accountId,
          "reserved-ip",
          ip.id,
          ip.displayName || ip.ipAddress,
          {
            name: ip.displayName ?? "",
            region: scope.region,
            compartmentId: ip.compartmentId,
            compartmentName: names.get(ip.compartmentId) ?? "",
            ipAddress: ip.ipAddress,
            status: ip.lifecycleState,
            assignedEntityId: ip.assignedEntityId ?? "",
            assignedEntityType: ip.assignedEntityType ?? "",
          },
          { ipAddress: ip.ipAddress, id: ip.id },
          ip.timeCreated ? { createdAt: ip.timeCreated } : {},
        ),
      );
  });
}

export async function listLoadBalancers(ctx: ListContext): Promise<ResourceInstance[]> {
  const names = await compartmentNames(ctx);
  return perScope(ctx, "loadbalancer", async (scope) => {
    const [lbs, healths] = await Promise.all([
      ctx.api.listAll<{
        id: string;
        displayName: string;
        compartmentId: string;
        shapeName: string;
        shapeDetails?: { minimumBandwidthInMbps?: number; maximumBandwidthInMbps?: number };
        ipAddresses?: Array<{ ipAddress: string; isPublic?: boolean }>;
        isPrivate?: boolean;
        subnetIds?: string[];
        backendSets?: Record<string, unknown>;
        listeners?: Record<string, unknown>;
        lifecycleState: string;
        timeCreated?: string;
      }>({
        service: "iaas",
        region: scope.region,
        path: "/20170115/loadBalancers",
        query: { compartmentId: scope.compartmentId, limit: 1000 },
      }),
      ctx.api
        .listAll<{ loadBalancerId: string; status: string }>({
          service: "iaas",
          region: scope.region,
          path: "/20170115/loadBalancerHealths",
          query: { compartmentId: scope.compartmentId, limit: 1000 },
        })
        .catch(() => []),
    ]);
    const health = new Map(healths.map((h) => [h.loadBalancerId, h.status]));
    return lbs
      .filter((lb) => ALIVE(lb.lifecycleState))
      .map((lb) => {
        const ips = (lb.ipAddresses ?? []).map((ip) => ip.ipAddress);
        return makeResource(
          ctx.accountId,
          "load-balancer",
          lb.id,
          lb.displayName,
          {
            name: lb.displayName,
            region: scope.region,
            compartmentId: lb.compartmentId,
            compartmentName: names.get(lb.compartmentId) ?? "",
            shape: lb.shapeName,
            ...(lb.shapeDetails?.minimumBandwidthInMbps !== undefined
              ? { minBandwidthMbps: lb.shapeDetails.minimumBandwidthInMbps }
              : {}),
            ...(lb.shapeDetails?.maximumBandwidthInMbps !== undefined
              ? { maxBandwidthMbps: lb.shapeDetails.maximumBandwidthInMbps }
              : {}),
            isPrivate: lb.isPrivate === true,
            ipAddresses: ips.join(", "),
            subnetIds: (lb.subnetIds ?? []).join(", "),
            backendSetCount: Object.keys(lb.backendSets ?? {}).length,
            listenerCount: Object.keys(lb.listeners ?? {}).length,
            health: health.get(lb.id) ?? "",
            status: lb.lifecycleState,
          },
          { ipAddress: ips[0] ?? "", id: lb.id },
          lb.timeCreated ? { createdAt: lb.timeCreated } : {},
        );
      });
  });
}

// ---------------------------------------------------------------------------
// Object Storage

const namespaceCache = new Map<string, Promise<string>>();

/** The tenancy's Object Storage namespace (one per tenancy, same in every region). */
export function objectStorageNamespace(api: OciApi, region: string): Promise<string> {
  const key = api.tenancyOcid;
  if (!namespaceCache.has(key)) {
    const p = api.get<string>("objectstorage", region, "/n");
    p.catch(() => namespaceCache.delete(key));
    namespaceCache.set(key, p);
  }
  return namespaceCache.get(key)!;
}

/** Bucket external id: `region/name`; names are only unique per region. */
export function bucketExternalId(region: string, name: string): string {
  return `${region}/${name}`;
}

export function parseBucketExternalId(id: string): { region: string; name: string } {
  const slash = id.indexOf("/");
  return { region: id.slice(0, slash), name: id.slice(slash + 1) };
}

export interface OciBucket {
  name: string;
  namespace: string;
  compartmentId: string;
  storageTier?: string;
  publicAccessType?: string;
  versioning?: string;
  autoTiering?: string;
  approximateCount?: number;
  approximateSize?: number;
  timeCreated?: string;
}

export function mapBucket(
  ctx: ListContext,
  region: string,
  b: OciBucket,
  names: Map<string, string>,
): ResourceInstance {
  return makeResource(
    ctx.accountId,
    "bucket",
    bucketExternalId(region, b.name),
    b.name,
    {
      name: b.name,
      region,
      compartmentId: b.compartmentId,
      compartmentName: names.get(b.compartmentId) ?? "",
      namespace: b.namespace,
      storageTier: b.storageTier ?? "Standard",
      publicAccessType: b.publicAccessType ?? "NoPublicAccess",
      versioning: b.versioning ?? "Disabled",
      autoTiering: b.autoTiering ?? "Disabled",
      ...(b.approximateCount !== undefined ? { approximateCount: b.approximateCount } : {}),
      ...(b.approximateSize !== undefined
        ? { approximateSizeGb: Number((b.approximateSize / 1024 ** 3).toFixed(3)) }
        : {}),
    },
    { name: b.name, namespace: b.namespace },
    b.timeCreated ? { createdAt: b.timeCreated } : {},
  );
}

export async function getBucket(
  ctx: ListContext,
  region: string,
  name: string,
  names?: Map<string, string>,
): Promise<ResourceInstance> {
  const ns = await objectStorageNamespace(ctx.api, region);
  const b = await ctx.api.get<OciBucket>(
    "objectstorage",
    region,
    `/n/${encodeURIComponent(ns)}/b/${encodeURIComponent(name)}`,
    { fields: "approximateCount,approximateSize,autoTiering" },
  );
  return mapBucket(ctx, region, b, names ?? (await compartmentNames(ctx)));
}

export async function listBuckets(ctx: ListContext): Promise<ResourceInstance[]> {
  const names = await compartmentNames(ctx);
  return perScope(ctx, "bucket", async (scope) => {
    const ns = await objectStorageNamespace(ctx.api, scope.region);
    const summaries = await ctx.api.listAll<{ name: string }>({
      service: "objectstorage",
      region: scope.region,
      path: `/n/${encodeURIComponent(ns)}/b`,
      query: { compartmentId: scope.compartmentId, limit: 1000 },
    });
    // The summary carries no tier, access or size; GetBucket does.
    return mapLimit(summaries, CONCURRENCY, (s) => getBucket(ctx, scope.region, s.name, names));
  });
}

// ---------------------------------------------------------------------------
// Autonomous Database

export interface OciAutonomousDatabase {
  id: string;
  displayName: string;
  dbName: string;
  compartmentId: string;
  dbWorkload?: string;
  computeModel?: string;
  computeCount?: number;
  cpuCoreCount?: number;
  dataStorageSizeInTBs?: number;
  isAutoScalingEnabled?: boolean;
  lifecycleState: string;
  licenseModel?: string;
  isFreeTier?: boolean;
  dbVersion?: string;
  serviceConsoleUrl?: string;
  connectionUrls?: { sqlDevWebUrl?: string };
  connectionStrings?: { high?: string };
  timeCreated?: string;
}

export function mapAutonomousDatabase(
  ctx: ListContext,
  region: string,
  db: OciAutonomousDatabase,
  names: Map<string, string>,
): ResourceInstance {
  return makeResource(
    ctx.accountId,
    "autonomous-database",
    db.id,
    db.displayName,
    {
      name: db.displayName,
      dbName: db.dbName,
      region,
      compartmentId: db.compartmentId,
      compartmentName: names.get(db.compartmentId) ?? "",
      workload: db.dbWorkload ?? "",
      computeModel: db.computeModel ?? "",
      computeCount: db.computeCount ?? db.cpuCoreCount ?? 0,
      ...(db.dataStorageSizeInTBs !== undefined ? { storageTb: db.dataStorageSizeInTBs } : {}),
      autoScaling: db.isAutoScalingEnabled === true,
      status: db.lifecycleState,
      licenseModel: db.licenseModel ?? "",
      freeTier: db.isFreeTier === true,
      dbVersion: db.dbVersion ?? "",
    },
    {
      serviceConsoleUrl: db.serviceConsoleUrl ?? "",
      sqlDevWebUrl: db.connectionUrls?.sqlDevWebUrl ?? "",
      connectionStringHigh: db.connectionStrings?.high ?? "",
      id: db.id,
    },
    db.timeCreated ? { createdAt: db.timeCreated } : {},
  );
}

export async function listAutonomousDatabases(ctx: ListContext): Promise<ResourceInstance[]> {
  const names = await compartmentNames(ctx);
  return perScope(ctx, "autonomousdatabase", async (scope) => {
    const dbs = await ctx.api.listAll<OciAutonomousDatabase>({
      service: "database",
      region: scope.region,
      path: "/20160918/autonomousDatabases",
      query: { compartmentId: scope.compartmentId, limit: 1000 },
    });
    return dbs
      .filter((d) => ALIVE(d.lifecycleState))
      .map((d) => mapAutonomousDatabase(ctx, scope.region, d, names));
  });
}

// ---------------------------------------------------------------------------
// OKE

interface OciCluster {
  id: string;
  name: string;
  compartmentId: string;
  vcnId?: string;
  kubernetesVersion?: string;
  availableKubernetesUpgrades?: string[];
  type?: string;
  endpoints?: { kubernetes?: string; publicEndpoint?: string; privateEndpoint?: string };
  lifecycleState: string;
  metadata?: { timeCreated?: string };
}

export async function listOkeClusters(ctx: ListContext): Promise<ResourceInstance[]> {
  const names = await compartmentNames(ctx);
  return perScope(ctx, "clusterscluster", async (scope) => {
    const clusters = await ctx.api.listAll<OciCluster>({
      service: "containerengine",
      region: scope.region,
      path: "/20180222/clusters",
      query: { compartmentId: scope.compartmentId, limit: 1000 },
    });
    return clusters
      .filter((c) => ALIVE(c.lifecycleState))
      .map((c) => {
        const endpoint =
          c.endpoints?.publicEndpoint ??
          c.endpoints?.privateEndpoint ??
          c.endpoints?.kubernetes ??
          "";
        return makeResource(
          ctx.accountId,
          "oke-cluster",
          c.id,
          c.name,
          {
            name: c.name,
            region: scope.region,
            compartmentId: c.compartmentId,
            compartmentName: names.get(c.compartmentId) ?? "",
            kubernetesVersion: c.kubernetesVersion ?? "",
            clusterType: c.type ?? "BASIC_CLUSTER",
            vcnId: c.vcnId ?? "",
            endpoint,
            availableUpgrades: (c.availableKubernetesUpgrades ?? []).join(", "),
            status: c.lifecycleState,
          },
          { endpoint, id: c.id },
          c.metadata?.timeCreated ? { createdAt: c.metadata.timeCreated } : {},
        );
      });
  });
}

export async function listNodePools(ctx: ListContext): Promise<ResourceInstance[]> {
  // Node pools are not a Search type; they live beside their cluster, so
  // the cluster scopes are the node pool scopes.
  return perScope(ctx, "clusterscluster", async (scope) => {
    const pools = await ctx.api.listAll<{
      id: string;
      name: string;
      clusterId: string;
      compartmentId: string;
      nodeShape: string;
      nodeShapeConfig?: { ocpus?: number; memoryInGBs?: number };
      nodeConfigDetails?: { size?: number };
      kubernetesVersion?: string;
      lifecycleState: string;
    }>({
      service: "containerengine",
      region: scope.region,
      path: "/20180222/nodePools",
      query: { compartmentId: scope.compartmentId, limit: 1000 },
    });
    return pools
      .filter((p) => ALIVE(p.lifecycleState))
      .map((p) =>
        makeResource(
          ctx.accountId,
          "node-pool",
          p.id,
          p.name,
          {
            name: p.name,
            region: scope.region,
            compartmentId: p.compartmentId,
            clusterId: p.clusterId,
            nodeShape: p.nodeShape,
            ...(p.nodeShapeConfig?.ocpus !== undefined ? { ocpus: p.nodeShapeConfig.ocpus } : {}),
            ...(p.nodeShapeConfig?.memoryInGBs !== undefined
              ? { memoryGb: p.nodeShapeConfig.memoryInGBs }
              : {}),
            nodeCount: p.nodeConfigDetails?.size ?? 0,
            kubernetesVersion: p.kubernetesVersion ?? "",
            status: p.lifecycleState,
          },
          { id: p.id },
          { parentResourceId: `${ctx.accountId}:oke-cluster:${p.clusterId}` },
        ),
      );
  });
}

// ---------------------------------------------------------------------------
// Budgets (root compartment, home region)

export interface OciBudget {
  id: string;
  displayName: string;
  description?: string;
  amount: number;
  targetType?: string;
  targets?: string[];
  processingPeriodType?: string;
  actualSpend?: number;
  forecastedSpend?: number;
  timeSpendComputed?: string;
  alertRuleCount?: number;
  lifecycleState: string;
  timeCreated?: string;
}

export function mapBudget(ctx: ListContext, b: OciBudget): ResourceInstance {
  return makeResource(
    ctx.accountId,
    "budget",
    b.id,
    b.displayName,
    {
      name: b.displayName,
      description: b.description ?? "",
      amount: b.amount,
      targetType: b.targetType ?? "COMPARTMENT",
      targets: (b.targets ?? []).join(", "),
      processingPeriodType: b.processingPeriodType ?? "MONTH",
      ...(b.actualSpend !== undefined ? { actualSpend: b.actualSpend } : {}),
      ...(b.forecastedSpend !== undefined ? { forecastedSpend: b.forecastedSpend } : {}),
      timeSpendComputed: b.timeSpendComputed ?? "",
      alertRuleCount: b.alertRuleCount ?? 0,
      status: b.lifecycleState,
    },
    { id: b.id },
    b.timeCreated ? { createdAt: b.timeCreated } : {},
  );
}

export async function listBudgets(ctx: ListContext): Promise<ResourceInstance[]> {
  try {
    const budgets = await ctx.api.listAll<OciBudget>({
      service: "usage",
      region: ctx.inventory.homeRegion,
      path: "/20190111/budgets",
      query: { compartmentId: ctx.api.tenancyOcid, targetType: "ALL", limit: 1000 },
    });
    return budgets.map((b) => mapBudget(ctx, b));
  } catch (err) {
    if (isAuthorizationGap(err)) return [];
    throw err;
  }
}

export interface OciAlertRule {
  id: string;
  budgetId: string;
  displayName: string;
  type: string;
  thresholdType: string;
  threshold: number;
  recipients?: string;
  message?: string;
  lifecycleState: string;
  timeCreated?: string;
}

export function mapAlertRule(ctx: ListContext, r: OciAlertRule): ResourceInstance {
  return makeResource(
    ctx.accountId,
    "budget-alert-rule",
    `${r.budgetId}/${r.id}`,
    r.displayName || `${r.type} ${r.threshold}${r.thresholdType === "PERCENTAGE" ? "%" : ""}`,
    {
      name: r.displayName ?? "",
      type: r.type,
      thresholdType: r.thresholdType,
      threshold: r.threshold,
      recipients: r.recipients ?? "",
      message: r.message ?? "",
      budgetId: r.budgetId,
      status: r.lifecycleState,
    },
    {},
    {
      parentResourceId: `${ctx.accountId}:budget:${r.budgetId}`,
      ...(r.timeCreated ? { createdAt: r.timeCreated } : {}),
    },
  );
}

export async function listAlertRules(ctx: ListContext): Promise<ResourceInstance[]> {
  const budgets = await listBudgets(ctx);
  const rules = await mapLimit(budgets, CONCURRENCY, async (b) =>
    ctx.api
      .listAll<OciAlertRule>({
        service: "usage",
        region: ctx.inventory.homeRegion,
        path: `/20190111/budgets/${b.externalId}/alertRules`,
        query: { limit: 1000 },
      })
      .then((rows) => rows.map((r) => ({ ...r, budgetId: r.budgetId || b.externalId! })))
      .catch((err: unknown) => {
        if (isAuthorizationGap(err)) return [] as OciAlertRule[];
        throw err;
      }),
  );
  return rules.flat().map((r) => mapAlertRule(ctx, r));
}
