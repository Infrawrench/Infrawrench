import type { ResourceInstance } from "@infrawrench/plugin-base";
import { isPermissionGap, mapLimit, type IbmApi } from "./api.js";
import {
  CODE_ENGINE_REGIONS,
  CONTAINERS,
  COS_CONFIG,
  DEFAULT_REGION,
  IBM_REGIONS,
  RESOURCE_CONTROLLER,
  VPC_API_VERSION,
  codeEngineBase,
  cosEndpoint,
  crnService,
  databasesBase,
  parseLocationConstraint,
  vpcBase,
} from "./regions.js";

/**
 * Listers. Response field names follow IBM's own Go SDKs (vpc-go-sdk
 * `vpcv1`, platform-services-go-sdk `resourcecontrollerv2` /
 * `resourcemanagerv2`, code-engine-go-sdk `codeenginev2`,
 * cloud-databases-go-sdk `clouddatabasesv5`, container-services-go-sdk
 * `kubernetesserviceapiv1`), which are generated from the API definitions.
 */

export const PLUGIN_ID = "ibm-cloud";

/** Accounts plus the regions to scan, shared by every lister. */
export class Inventory {
  private regionsPromise: Promise<string[]> | null = null;

  constructor(
    readonly api: IbmApi,
    readonly homeRegion: string,
    private readonly configured: string[],
  ) {}

  regions(): Promise<string[]> {
    if (this.configured.length) return Promise.resolve(this.configured);
    if (!this.regionsPromise) {
      this.regionsPromise = this.api
        .get<{ regions?: Array<{ name: string; status?: string }> }>(
          `${vpcBase(this.homeRegion)}/regions`,
          {
            version: VPC_API_VERSION,
            generation: 2,
          },
        )
        .then((r) => {
          const names = (r.regions ?? [])
            .filter((x) => x.status !== "unavailable")
            .map((x) => x.name);
          return names.length ? names : [this.homeRegion];
        })
        .catch((err: unknown) => {
          this.regionsPromise = null;
          if (isPermissionGap(err)) return IBM_REGIONS.map((r) => r.id);
          throw err;
        });
    }
    return this.regionsPromise;
  }
}

export interface ListContext {
  api: IbmApi;
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
  outputs: Record<string, string | undefined> = {},
  extra: { createdAt?: string | undefined; parent?: { typeId: string; id: string } } = {},
): ResourceInstance {
  const created =
    extra.createdAt && !Number.isNaN(Date.parse(extra.createdAt))
      ? new Date(extra.createdAt).toISOString()
      : new Date(0).toISOString();
  const clean: Record<string, FieldValue> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) clean[k] = v;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(outputs)) if (v) out[k] = v;
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: clean,
    resolvedOutputs: out,
    secretStates: [],
    externalId,
    createdAt: created,
    updatedAt: created,
    ...(extra.parent
      ? { parentResourceId: `${accountId}:${extra.parent.typeId}:${extra.parent.id}` }
      : {}),
  };
}

export function splitRegional(externalId: string): { region: string; id: string } {
  const i = externalId.indexOf("/");
  if (i < 0)
    throw Object.assign(new Error(`IBM Cloud plugin: malformed id "${externalId}"`), {
      status: 400,
    });
  return { region: externalId.slice(0, i), id: externalId.slice(i + 1) };
}

export function notFound(typeId: string, id: string): Error {
  return Object.assign(new Error(`IBM Cloud plugin: ${typeId} ${id} not found`), { status: 404 });
}

/** Run per region; a refused region lists empty unless every region refuses. */
export async function perRegion<T>(
  ctx: ListContext,
  regions: string[],
  fn: (region: string) => Promise<T[]>,
): Promise<T[]> {
  let refused: unknown = null;
  let refusedCount = 0;
  const results = await mapLimit(regions, 6, async (region) => {
    try {
      return await fn(region);
    } catch (err) {
      if (isPermissionGap(err)) {
        refused = err;
        refusedCount++;
        return [];
      }
      throw err;
    }
  });
  if (regions.length > 0 && refusedCount === regions.length && refused) throw refused;
  return results.flat();
}

async function vpcRegions(ctx: ListContext): Promise<string[]> {
  return ctx.regionHint ? [ctx.regionHint] : ctx.inventory.regions();
}

/** Page a VPC collection by following `next.href`'s `start` token. */
export async function vpcList<T>(
  api: IbmApi,
  region: string,
  path: string,
  key: string,
  query: Record<string, string | number | undefined> = {},
): Promise<T[]> {
  const out: T[] = [];
  let start: string | undefined;
  for (let page = 0; page < 100; page++) {
    const res = await api.get<Record<string, unknown>>(`${vpcBase(region)}${path}`, {
      version: VPC_API_VERSION,
      generation: 2,
      limit: 100,
      ...query,
      ...(start ? { start } : {}),
    });
    out.push(...((res[key] as T[] | undefined) ?? []));
    const href = (res["next"] as { href?: string } | undefined)?.href;
    if (!href) break;
    start = new URL(href).searchParams.get("start") ?? undefined;
    if (!start) break;
  }
  return out;
}

export async function vpcGet<T>(api: IbmApi, region: string, path: string): Promise<T> {
  return api.get<T>(`${vpcBase(region)}${path}`, { version: VPC_API_VERSION, generation: 2 });
}

const ref = (v: { id?: string; name?: string } | undefined | null) => v?.id ?? "";

// ---------------------------------------------------------------------------
// Account and resource groups

export async function listAccount(ctx: ListContext): Promise<ResourceInstance[]> {
  const token = await ctx.api.getToken();
  const regions = await ctx.inventory.regions().catch(() => [ctx.inventory.homeRegion]);
  return [
    makeResource(
      ctx.accountId,
      "account",
      token.accountId,
      `IBM Cloud ${token.accountId}`,
      {
        accountId: token.accountId,
        identity: token.subject,
        homeRegion: ctx.inventory.homeRegion,
        regions: regions.join(", "),
      },
      { accountId: token.accountId },
    ),
  ];
}

export interface ResourceGroup {
  id: string;
  name: string;
  state?: string;
  default?: boolean;
  created_at?: string;
}

export async function resourceGroups(api: IbmApi): Promise<ResourceGroup[]> {
  const accountId = await api.accountId();
  const res = await api.get<{ resources?: ResourceGroup[] }>(
    `${RESOURCE_CONTROLLER}/v2/resource_groups`,
    {
      account_id: accountId,
    },
  );
  return res.resources ?? [];
}

export async function listResourceGroups(ctx: ListContext): Promise<ResourceInstance[]> {
  return (await resourceGroups(ctx.api)).map((g) =>
    makeResource(
      ctx.accountId,
      "resource-group",
      g.id,
      g.name,
      { name: g.name, isDefault: g.default, state: g.state ?? "", createdAt: g.created_at ?? "" },
      { id: g.id },
      { createdAt: g.created_at },
    ),
  );
}

// ---------------------------------------------------------------------------
// VPC

interface VpcInstance {
  id: string;
  name: string;
  status?: string;
  zone?: { name?: string };
  profile?: { name?: string };
  vcpu?: { count?: number };
  memory?: number;
  gpu?: { count?: number };
  image?: { id?: string; name?: string };
  vpc?: { id?: string };
  primary_network_interface?: {
    id?: string;
    primary_ip?: { address?: string };
    subnet?: { id?: string };
  };
  boot_volume_attachment?: { volume?: { id?: string } };
  resource_group?: { id?: string };
  created_at?: string;
}

interface FloatingIp {
  id: string;
  name: string;
  address?: string;
  status?: string;
  zone?: { name?: string };
  target?: { id?: string; name?: string; resource_type?: string; href?: string } | null;
  resource_group?: { id?: string };
  created_at?: string;
}

/** Map a floating IP target (a network interface) back to the server that owns it. */
function instanceIdFromTarget(target: FloatingIp["target"]): string {
  const m = /\/instances\/([^/]+)\/network_interfaces\//.exec(target?.href ?? "");
  return m?.[1] ?? "";
}

export function mapInstance(
  accountId: string,
  region: string,
  i: VpcInstance,
  floating: Map<string, string>,
): ResourceInstance {
  const nicId = i.primary_network_interface?.id ?? "";
  return makeResource(
    accountId,
    "instance",
    `${region}/${i.id}`,
    i.name,
    {
      name: i.name,
      region,
      zone: i.zone?.name ?? "",
      profile: i.profile?.name ?? "",
      vcpus: i.vcpu?.count,
      memoryGb: i.memory,
      gpus: i.gpu?.count || undefined,
      status: i.status ?? "",
      image: i.image?.name ?? "",
      imageId: i.image?.id ?? "",
      vpcId: ref(i.vpc),
      subnetId: i.primary_network_interface?.subnet?.id ?? "",
      bootVolumeId: i.boot_volume_attachment?.volume?.id ?? "",
      sshUsername: "root",
      resourceGroupId: ref(i.resource_group),
      createdAt: i.created_at ?? "",
    },
    {
      publicIp: floating.get(nicId),
      privateIp: i.primary_network_interface?.primary_ip?.address,
      id: i.id,
    },
    { createdAt: i.created_at },
  );
}

async function floatingByNic(api: IbmApi, region: string): Promise<Map<string, string>> {
  const ips = await vpcList<FloatingIp>(api, region, "/floating_ips", "floating_ips").catch(
    () => [] as FloatingIp[],
  );
  return new Map(
    ips.filter((f) => f.target?.id && f.address).map((f) => [f.target!.id!, f.address!]),
  );
}

export async function listInstances(ctx: ListContext): Promise<ResourceInstance[]> {
  return perRegion(ctx, await vpcRegions(ctx), async (region) => {
    const [instances, floating] = await Promise.all([
      vpcList<VpcInstance>(ctx.api, region, "/instances", "instances"),
      floatingByNic(ctx.api, region),
    ]);
    return instances.map((i) => mapInstance(ctx.accountId, region, i, floating));
  });
}

export async function getInstance(
  ctx: ListContext,
  region: string,
  id: string,
): Promise<ResourceInstance> {
  const [i, floating] = await Promise.all([
    vpcGet<VpcInstance>(ctx.api, region, `/instances/${id}`),
    floatingByNic(ctx.api, region),
  ]);
  return mapInstance(ctx.accountId, region, i, floating);
}

export async function listVolumes(ctx: ListContext): Promise<ResourceInstance[]> {
  interface Volume {
    id: string;
    name: string;
    capacity?: number;
    iops?: number;
    profile?: { name?: string };
    status?: string;
    attachment_state?: string;
    zone?: { name?: string };
    volume_attachments?: Array<{ instance?: { id?: string } }>;
    resource_group?: { id?: string };
    created_at?: string;
  }
  return perRegion(ctx, await vpcRegions(ctx), async (region) =>
    (await vpcList<Volume>(ctx.api, region, "/volumes", "volumes")).map((v) =>
      makeResource(
        ctx.accountId,
        "volume",
        `${region}/${v.id}`,
        v.name,
        {
          name: v.name,
          region,
          zone: v.zone?.name ?? "",
          capacityGb: v.capacity,
          profile: v.profile?.name ?? "",
          iops: v.iops,
          status: v.status ?? "",
          attachmentState: v.attachment_state ?? "",
          attachedTo: (v.volume_attachments ?? [])
            .map((a) => a.instance?.id)
            .filter(Boolean)
            .join(", "),
          resourceGroupId: ref(v.resource_group),
          createdAt: v.created_at ?? "",
        },
        { id: v.id },
        { createdAt: v.created_at },
      ),
    ),
  );
}

export async function listVpcs(ctx: ListContext): Promise<ResourceInstance[]> {
  interface Vpc {
    id: string;
    name: string;
    status?: string;
    classic_access?: boolean;
    default_security_group?: { id?: string };
    resource_group?: { id?: string };
    created_at?: string;
  }
  return perRegion(ctx, await vpcRegions(ctx), async (region) =>
    (await vpcList<Vpc>(ctx.api, region, "/vpcs", "vpcs")).map((v) =>
      makeResource(
        ctx.accountId,
        "vpc",
        `${region}/${v.id}`,
        v.name,
        {
          name: v.name,
          region,
          status: v.status ?? "",
          classicAccess: v.classic_access,
          defaultSecurityGroupId: ref(v.default_security_group),
          resourceGroupId: ref(v.resource_group),
          createdAt: v.created_at ?? "",
        },
        { id: v.id },
        { createdAt: v.created_at },
      ),
    ),
  );
}

export async function listSubnets(ctx: ListContext): Promise<ResourceInstance[]> {
  interface Subnet {
    id: string;
    name: string;
    status?: string;
    zone?: { name?: string };
    vpc?: { id?: string };
    ipv4_cidr_block?: string;
    available_ipv4_address_count?: number;
    total_ipv4_address_count?: number;
    public_gateway?: { id?: string } | null;
    resource_group?: { id?: string };
    created_at?: string;
  }
  return perRegion(ctx, await vpcRegions(ctx), async (region) =>
    (await vpcList<Subnet>(ctx.api, region, "/subnets", "subnets")).map((s) =>
      makeResource(
        ctx.accountId,
        "subnet",
        `${region}/${s.id}`,
        s.name,
        {
          name: s.name,
          region,
          zone: s.zone?.name ?? "",
          vpcId: ref(s.vpc),
          cidrBlock: s.ipv4_cidr_block ?? "",
          availableIps: s.available_ipv4_address_count,
          totalIps: s.total_ipv4_address_count,
          publicGatewayId: s.public_gateway?.id ?? "",
          status: s.status ?? "",
          resourceGroupId: ref(s.resource_group),
          createdAt: s.created_at ?? "",
        },
        { id: s.id },
        { createdAt: s.created_at },
      ),
    ),
  );
}

export interface SgRule {
  direction?: string;
  protocol?: string;
  port_min?: number;
  port_max?: number;
  remote?: { cidr_block?: string; address?: string; id?: string; name?: string };
}

/** Inbound rules summary, plus ports reachable from 0.0.0.0/0 and whether SSH/RDP is among them. */
export function analyseRules(rules: SgRule[]): {
  inbound: string;
  openPorts: string;
  adminOpen: boolean;
} {
  const inbound = rules.filter((r) => r.direction === "inbound");
  const open: string[] = [];
  let adminOpen = false;
  for (const r of inbound) {
    const remote = r.remote?.cidr_block ?? r.remote?.address ?? "";
    if (remote !== "0.0.0.0/0" && remote !== "::/0") continue;
    const proto = (r.protocol ?? "").toLowerCase();
    if (
      proto === "all" ||
      proto === "any" ||
      ((proto === "tcp" || proto === "udp") && r.port_min === undefined)
    ) {
      open.push("all");
      adminOpen = true;
      continue;
    }
    if (proto !== "tcp") continue;
    const from = r.port_min ?? 1;
    const to = r.port_max ?? 65535;
    open.push(from === to ? String(from) : `${from}-${to}`);
    if ((from <= 22 && to >= 22) || (from <= 3389 && to >= 3389)) adminOpen = true;
  }
  const text = inbound
    .map((r) => {
      const ports = r.port_min !== undefined ? ` ${r.port_min}-${r.port_max}` : "";
      const remote = r.remote?.cidr_block ?? r.remote?.address ?? r.remote?.name ?? "any";
      return `${r.protocol ?? "all"}${ports} from ${remote}`;
    })
    .join("; ");
  return { inbound: text, openPorts: [...new Set(open)].join(", "), adminOpen };
}

export async function listSecurityGroups(ctx: ListContext): Promise<ResourceInstance[]> {
  interface Sg {
    id: string;
    name: string;
    vpc?: { id?: string };
    rules?: SgRule[];
    targets?: unknown[];
    resource_group?: { id?: string };
    created_at?: string;
  }
  return perRegion(ctx, await vpcRegions(ctx), async (region) =>
    (await vpcList<Sg>(ctx.api, region, "/security_groups", "security_groups")).map((g) => {
      const a = analyseRules(g.rules ?? []);
      return makeResource(
        ctx.accountId,
        "security-group",
        `${region}/${g.id}`,
        g.name,
        {
          name: g.name,
          region,
          vpcId: ref(g.vpc),
          inboundRules: a.inbound,
          ruleCount: g.rules?.length ?? 0,
          targetCount: g.targets?.length ?? 0,
          internetOpenPorts: a.openPorts,
          adminPortsOpen: a.adminOpen,
          resourceGroupId: ref(g.resource_group),
          createdAt: g.created_at ?? "",
        },
        { id: g.id },
        { createdAt: g.created_at },
      );
    }),
  );
}

export async function listFloatingIps(ctx: ListContext): Promise<ResourceInstance[]> {
  return perRegion(ctx, await vpcRegions(ctx), async (region) =>
    (await vpcList<FloatingIp>(ctx.api, region, "/floating_ips", "floating_ips")).map((f) =>
      makeResource(
        ctx.accountId,
        "floating-ip",
        `${region}/${f.id}`,
        f.name,
        {
          name: f.name,
          region,
          zone: f.zone?.name ?? "",
          address: f.address ?? "",
          status: f.status ?? "",
          targetName: f.target?.name ?? "",
          instanceId: instanceIdFromTarget(f.target),
          resourceGroupId: ref(f.resource_group),
          createdAt: f.created_at ?? "",
        },
        { address: f.address, id: f.id },
        { createdAt: f.created_at },
      ),
    ),
  );
}

export async function listLoadBalancers(ctx: ListContext): Promise<ResourceInstance[]> {
  interface Lb {
    id: string;
    name: string;
    hostname?: string;
    is_public?: boolean;
    operating_status?: string;
    provisioning_status?: string;
    profile?: { name?: string };
    listeners?: unknown[];
    pools?: unknown[];
    subnets?: Array<{ id?: string }>;
    resource_group?: { id?: string };
    created_at?: string;
  }
  return perRegion(ctx, await vpcRegions(ctx), async (region) =>
    (await vpcList<Lb>(ctx.api, region, "/load_balancers", "load_balancers")).map((l) =>
      makeResource(
        ctx.accountId,
        "load-balancer",
        `${region}/${l.id}`,
        l.name,
        {
          name: l.name,
          region,
          hostname: l.hostname ?? "",
          profile: l.profile?.name ?? "",
          isPublic: l.is_public,
          operatingStatus: l.operating_status ?? "",
          status: l.provisioning_status ?? "",
          listenerCount: l.listeners?.length ?? 0,
          poolCount: l.pools?.length ?? 0,
          subnetIds: (l.subnets ?? [])
            .map((s) => s.id)
            .filter(Boolean)
            .join(", "),
          resourceGroupId: ref(l.resource_group),
          createdAt: l.created_at ?? "",
        },
        { hostname: l.hostname, id: l.id },
        { createdAt: l.created_at },
      ),
    ),
  );
}

export interface VpcKey {
  id: string;
  name: string;
  type?: string;
  fingerprint?: string;
  length?: number;
  public_key?: string;
  resource_group?: { id?: string };
  created_at?: string;
}

export async function listKeys(ctx: ListContext): Promise<ResourceInstance[]> {
  return perRegion(ctx, await vpcRegions(ctx), async (region) =>
    (await vpcList<VpcKey>(ctx.api, region, "/keys", "keys")).map((k) =>
      makeResource(
        ctx.accountId,
        "ssh-key",
        `${region}/${k.id}`,
        k.name,
        {
          name: k.name,
          region,
          type: k.type ?? "",
          fingerprint: k.fingerprint ?? "",
          length: k.length,
          resourceGroupId: ref(k.resource_group),
          createdAt: k.created_at ?? "",
        },
        { id: k.id, fingerprint: k.fingerprint },
        { createdAt: k.created_at },
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Kubernetes Service

interface Cluster {
  id: string;
  name: string;
  region?: string;
  type?: string;
  provider?: string;
  masterKubeVersion?: string;
  targetVersion?: string;
  state?: string;
  status?: string;
  workerCount?: number;
  masterURL?: string;
  versionEOS?: string;
  resourceGroup?: string;
  createdDate?: string;
}

export function mapCluster(accountId: string, c: Cluster): ResourceInstance {
  return makeResource(
    accountId,
    "kubernetes-cluster",
    c.id,
    c.name,
    {
      name: c.name,
      region: c.region ?? "",
      type: c.type ?? "",
      provider: c.provider ?? "",
      version: c.masterKubeVersion ?? "",
      targetVersion: c.targetVersion ?? "",
      state: c.state ?? "",
      status: c.status ?? "",
      workerCount: c.workerCount,
      versionEndOfSupport: c.versionEOS ?? "",
      resourceGroupId: c.resourceGroup ?? "",
      createdAt: c.createdDate ?? "",
    },
    { masterUrl: c.masterURL, id: c.id },
    { createdAt: c.createdDate },
  );
}

export async function listClusters(ctx: ListContext): Promise<ResourceInstance[]> {
  const [vpc, classic] = await Promise.all([
    ctx.api.get<Cluster[]>(`${CONTAINERS}/v2/vpc/getClusters`, { provider: "vpc-gen2" }),
    ctx.api.get<Cluster[]>(`${CONTAINERS}/v2/classic/getClusters`).catch((err: unknown) => {
      if (isPermissionGap(err)) return [] as Cluster[];
      throw err;
    }),
  ]);
  const seen = new Set<string>();
  return [...(vpc ?? []), ...(classic ?? [])]
    .filter((c) => c.id && !seen.has(c.id) && seen.add(c.id))
    .filter((c) => !ctx.regionHint || c.region === ctx.regionHint)
    .map((c) => mapCluster(ctx.accountId, c));
}

export async function getCluster(ctx: ListContext, id: string): Promise<ResourceInstance> {
  const c = await ctx.api.get<Cluster>(`${CONTAINERS}/v2/getCluster`, { cluster: id });
  return mapCluster(ctx.accountId, c);
}

interface WorkerPool {
  id: string;
  poolName?: string;
  flavor?: string;
  workerCount?: number;
  autoscaleEnabled?: boolean;
  operatingSystem?: string;
  zones?: Array<{ id?: string; workerCount?: number }>;
  lifecycle?: { actualState?: string };
}

export async function poolsOf(ctx: ListContext, clusterId: string): Promise<ResourceInstance[]> {
  const pools = await ctx.api.get<WorkerPool[]>(`${CONTAINERS}/v2/getWorkerPools`, {
    cluster: clusterId,
  });
  return (pools ?? []).map((p) => {
    const zones = p.zones ?? [];
    const total = zones.reduce((s, z) => s + (z.workerCount ?? 0), 0);
    return makeResource(
      ctx.accountId,
      "worker-pool",
      `${clusterId}/${p.id}`,
      p.poolName || p.id,
      {
        name: p.poolName ?? p.id,
        clusterId,
        flavor: p.flavor ?? "",
        sizePerZone: p.workerCount,
        zones: zones
          .map((z) => z.id)
          .filter(Boolean)
          .join(", "),
        workerCount: total || undefined,
        autoscale: p.autoscaleEnabled,
        operatingSystem: p.operatingSystem ?? "",
        state: p.lifecycle?.actualState ?? "",
      },
      { id: p.id },
      { parent: { typeId: "kubernetes-cluster", id: clusterId } },
    );
  });
}

export async function listWorkerPools(ctx: ListContext): Promise<ResourceInstance[]> {
  const clusters = await listClusters(ctx);
  return (
    await mapLimit(clusters, 4, (c) =>
      poolsOf(ctx, c.externalId!).catch((err: unknown) => {
        if (isPermissionGap(err)) return [] as ResourceInstance[];
        throw err;
      }),
    )
  ).flat();
}

// ---------------------------------------------------------------------------
// Code Engine

interface CeProject {
  id: string;
  name: string;
  region?: string;
  status?: string;
  resource_group_id?: string;
  created_at?: string;
}

export async function ceList<T>(api: IbmApi, url: string, key: string): Promise<T[]> {
  const out: T[] = [];
  let start: string | undefined;
  for (let page = 0; page < 50; page++) {
    const res = await api.get<Record<string, unknown>>(url, {
      limit: 100,
      ...(start ? { start } : {}),
    });
    out.push(...((res[key] as T[] | undefined) ?? []));
    start = (res["next"] as { start?: string } | undefined)?.start;
    if (!start) break;
  }
  return out;
}

export function mapProject(accountId: string, region: string, p: CeProject): ResourceInstance {
  return makeResource(
    accountId,
    "code-engine-project",
    `${region}/${p.id}`,
    p.name,
    {
      name: p.name,
      region,
      status: p.status ?? "",
      resourceGroupId: p.resource_group_id ?? "",
      createdAt: p.created_at ?? "",
    },
    { id: p.id },
    { createdAt: p.created_at },
  );
}

async function ceRegions(ctx: ListContext): Promise<string[]> {
  return (await vpcRegions(ctx)).filter((r) => CODE_ENGINE_REGIONS.has(r));
}

export async function listProjects(ctx: ListContext): Promise<ResourceInstance[]> {
  return perRegion(ctx, await ceRegions(ctx), async (region) =>
    (await ceList<CeProject>(ctx.api, `${codeEngineBase(region)}/projects`, "projects")).map((p) =>
      mapProject(ctx.accountId, region, p),
    ),
  );
}

export interface CeApp {
  name: string;
  project_id?: string;
  status?: string;
  endpoint?: string;
  endpoint_internal?: string;
  image_reference?: string;
  image_port?: number;
  scale_min_instances?: number;
  scale_max_instances?: number;
  scale_cpu_limit?: string;
  scale_memory_limit?: string;
  entity_tag?: string;
  created_at?: string;
}

export function mapApp(
  accountId: string,
  region: string,
  projectId: string,
  a: CeApp,
): ResourceInstance {
  return makeResource(
    accountId,
    "code-engine-app",
    `${region}/${projectId}/${a.name}`,
    a.name,
    {
      name: a.name,
      region,
      projectId,
      image: a.image_reference ?? "",
      port: a.image_port,
      minInstances: a.scale_min_instances,
      maxInstances: a.scale_max_instances,
      cpu: a.scale_cpu_limit ?? "",
      memory: a.scale_memory_limit ?? "",
      status: a.status ?? "",
      createdAt: a.created_at ?? "",
    },
    { url: a.endpoint, internalUrl: a.endpoint_internal },
    {
      createdAt: a.created_at,
      parent: { typeId: "code-engine-project", id: `${region}/${projectId}` },
    },
  );
}

export async function listApps(ctx: ListContext): Promise<ResourceInstance[]> {
  return perRegion(ctx, await ceRegions(ctx), async (region) => {
    const projects = await ceList<CeProject>(
      ctx.api,
      `${codeEngineBase(region)}/projects`,
      "projects",
    );
    const apps = await mapLimit(projects, 4, async (p) =>
      (await ceList<CeApp>(ctx.api, `${codeEngineBase(region)}/projects/${p.id}/apps`, "apps")).map(
        (a) => mapApp(ctx.accountId, region, p.id, a),
      ),
    );
    return apps.flat();
  });
}

// ---------------------------------------------------------------------------
// Resource Controller (service instances, databases, COS)

export interface ResourceInstanceRc {
  id: string;
  guid?: string;
  crn?: string;
  name: string;
  region_id?: string;
  resource_group_id?: string;
  resource_id?: string;
  resource_plan_id?: string;
  state?: string;
  type?: string;
  dashboard_url?: string;
  created_at?: string;
}

export async function resourceInstances(api: IbmApi): Promise<ResourceInstanceRc[]> {
  const out: ResourceInstanceRc[] = [];
  let url: string | undefined = `${RESOURCE_CONTROLLER}/v2/resource_instances?limit=100`;
  for (let page = 0; page < 100 && url; page++) {
    const res: { resources?: ResourceInstanceRc[]; next_url?: string | null } = await api.get(url);
    out.push(...(res.resources ?? []));
    url = res.next_url ? `${RESOURCE_CONTROLLER}${res.next_url}` : undefined;
  }
  return out;
}

export const isDatabaseService = (service: string) =>
  service.startsWith("databases-for-") || service === "messages-for-rabbitmq";

/** Services modelled by their own types, so the generic list leaves them out. */
const DEDICATED = (service: string) =>
  isDatabaseService(service) ||
  service === "containers-kubernetes" ||
  service === "codeengine" ||
  service === "is";

export function mapServiceInstance(accountId: string, r: ResourceInstanceRc): ResourceInstance {
  const crn = r.crn ?? r.id;
  return makeResource(
    accountId,
    "service-instance",
    crn,
    r.name,
    {
      name: r.name,
      service: crnService(crn),
      plan: r.resource_plan_id ?? "",
      region: r.region_id ?? "",
      guid: r.guid ?? "",
      state: r.state ?? "",
      resourceGroupId: r.resource_group_id ?? "",
      createdAt: r.created_at ?? "",
    },
    { dashboardUrl: r.dashboard_url, id: crn },
    { createdAt: r.created_at },
  );
}

export async function listServiceInstances(ctx: ListContext): Promise<ResourceInstance[]> {
  return (await resourceInstances(ctx.api))
    .filter((r) => !DEDICATED(crnService(r.crn ?? r.id)))
    .map((r) => mapServiceInstance(ctx.accountId, r));
}

interface DbGroup {
  id: string;
  members?: { allocation_count?: number };
  memory?: { allocation_mb?: number };
  disk?: { allocation_mb?: number };
  cpu?: { allocation_count?: number };
}

export async function databaseGroups(api: IbmApi, region: string, crn: string): Promise<DbGroup[]> {
  const res = await api.get<{ groups?: DbGroup[] }>(
    `${databasesBase(region)}/deployments/${encodeURIComponent(crn)}/groups`,
  );
  return res.groups ?? [];
}

export async function databaseResource(
  ctx: ListContext,
  r: ResourceInstanceRc,
): Promise<ResourceInstance> {
  const crn = r.crn ?? r.id;
  const region = r.region_id ?? DEFAULT_REGION;
  const [info, groups] = await Promise.all([
    ctx.api
      .get<{ deployment?: { version?: string } }>(
        `${databasesBase(region)}/deployments/${encodeURIComponent(crn)}`,
      )
      .catch(() => undefined),
    databaseGroups(ctx.api, region, crn).catch(() => [] as DbGroup[]),
  ]);
  const member = groups.find((g) => g.id === "member") ?? groups[0];
  return makeResource(
    ctx.accountId,
    "database",
    crn,
    r.name,
    {
      name: r.name,
      region,
      service: crnService(crn),
      version: info?.deployment?.version ?? "",
      plan: r.resource_plan_id ?? "",
      members: member?.members?.allocation_count,
      memoryMb: member?.memory?.allocation_mb,
      diskMb: member?.disk?.allocation_mb,
      cpu: member?.cpu?.allocation_count,
      state: r.state ?? "",
      resourceGroupId: r.resource_group_id ?? "",
      createdAt: r.created_at ?? "",
    },
    { id: crn },
    { createdAt: r.created_at },
  );
}

export async function listDatabases(ctx: ListContext): Promise<ResourceInstance[]> {
  const dbs = (await resourceInstances(ctx.api)).filter(
    (r) =>
      isDatabaseService(crnService(r.crn ?? r.id)) &&
      (!ctx.regionHint || r.region_id === ctx.regionHint),
  );
  return mapLimit(dbs, 4, (r) => databaseResource(ctx, r));
}

// COS

export function xmlValue(xml: string, tag: string): string {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1] ?? "";
}

export function parseBucketList(
  xml: string,
): Array<{ name: string; created: string; location: string; storageClass: string }> {
  return [...xml.matchAll(/<Bucket>([\s\S]*?)<\/Bucket>/g)].map((m) => {
    const { location, storageClass } = parseLocationConstraint(
      xmlValue(m[1]!, "LocationConstraint"),
    );
    return {
      name: xmlValue(m[1]!, "Name"),
      created: xmlValue(m[1]!, "CreationDate"),
      location,
      storageClass,
    };
  });
}

export async function listBuckets(ctx: ListContext): Promise<ResourceInstance[]> {
  const instances = (await resourceInstances(ctx.api)).filter(
    (r) => crnService(r.crn ?? r.id) === "cloud-object-storage" && r.guid,
  );
  const perInstance = await mapLimit(instances, 4, async (inst) => {
    const res = await ctx.api.request<string>({
      // The extended listing adds each bucket's LocationConstraint; any
      // endpoint lists every bucket of the instance.
      url: `https://${cosEndpoint("us")}/?extended`,
      headers: { "ibm-service-instance-id": inst.guid!, accept: "application/xml" },
      text: true,
    });
    return parseBucketList(res.data).map((b) => ({ ...b, instance: inst.guid! }));
  });
  const buckets = perInstance.flat();
  return mapLimit(buckets, 6, async (b) => {
    const config = await ctx.api
      .get<{ object_count?: number; bytes_used?: number }>(
        `${COS_CONFIG}/b/${encodeURIComponent(b.name)}`,
      )
      .catch(() => undefined);
    return makeResource(
      ctx.accountId,
      "cos-bucket",
      `${b.location}/${b.name}`,
      b.name,
      {
        name: b.name,
        location: b.location,
        storageClass: b.storageClass,
        serviceInstanceId: b.instance,
        objectCount: config?.object_count,
        storageGb:
          config?.bytes_used !== undefined
            ? Math.round((config.bytes_used / 1024 ** 3) * 100) / 100
            : undefined,
        createdAt: b.created,
      },
      { name: b.name, endpoint: cosEndpoint(b.location) },
      { createdAt: b.created },
    );
  });
}
