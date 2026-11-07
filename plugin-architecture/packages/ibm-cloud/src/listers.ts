import {
  pathEncode,
  type ApiListItem,
  type ApiResponse,
  type ResourceInstance,
} from "@infrawrench/plugin-base";
import { isPermissionGap, mapLimit, type IbmApi } from "./api.js";
import type {
  components as CodeEngineComponents,
  operations as CodeEngineOperations,
} from "./api-types.code-engine.gen.js";
import type { operations as ContainersOperations } from "./api-types.containers.gen.js";
import type { operations as DatabasesOperations } from "./api-types.databases.gen.js";
import type {
  components as ResourceControllerComponents,
  operations as ResourceControllerOperations,
} from "./api-types.resource-controller.gen.js";
import type { operations as ResourceManagerOperations } from "./api-types.resource-manager.gen.js";
import type { components as VpcComponents } from "./api-types.vpc.gen.js";
import {
  CODE_ENGINE_REGIONS,
  DEFAULT_REGION,
  IBM_REGIONS,
  RESOURCE_CONTROLLER,
  VPC_QUERY,
  cosEndpoint,
  crnService,
  parseLocationConstraint,
} from "./regions.js";

/**
 * Listers. Response types come from each service's own OpenAPI document
 * (`plugingen.json`).
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
        .vpc(this.homeRegion)
        .get("/regions", { query: VPC_QUERY })
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

export function malformedId(externalId: string): Error {
  return Object.assign(new Error(`IBM Cloud plugin: malformed id "${externalId}"`), {
    status: 400,
  });
}

export function splitRegional(externalId: string): { region: string; id: string } {
  const i = externalId.indexOf("/");
  if (i <= 0 || i === externalId.length - 1) throw malformedId(externalId);
  return { region: externalId.slice(0, i), id: externalId.slice(i + 1) };
}

/** A worker pool's external id, `cluster/pool`. */
export function splitPool(externalId: string): { cluster: string; pool: string } {
  const [cluster, pool, ...rest] = externalId.split("/");
  if (!cluster || !pool || rest.length) throw malformedId(externalId);
  return { cluster, pool };
}

/** A Code Engine app's external id, `region/project/name`. */
export function splitApp(externalId: string): { region: string; projectId: string; name: string } {
  const [region, projectId, name, ...rest] = externalId.split("/");
  if (!region || !projectId || !name || rest.length) throw malformedId(externalId);
  return { region, projectId, name };
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

/** What a VPC list call adds to its query, before the page's own `start`. */
export const VPC_LIST_QUERY = { ...VPC_QUERY, limit: 100 };

/**
 * Page a VPC collection by following `next.href`'s `start` token. `page` asks for
 * one page and `items` reads the list out of it, so both stay typed by the route.
 */
export async function vpcList<Page extends { next?: { href?: string } }, Item>(
  page: (paging: { start?: string }) => Promise<Page>,
  items: (page: Page) => readonly Item[] | undefined,
): Promise<Item[]> {
  const out: Item[] = [];
  let start: string | undefined;
  for (let n = 0; n < 100; n++) {
    const res = await page(start ? { start } : {});
    out.push(...(items(res) ?? []));
    const href = res.next?.href;
    if (!href) break;
    start = new URL(href).searchParams.get("start") ?? undefined;
    if (!start) break;
  }
  return out;
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

export async function resourceGroups(
  api: IbmApi,
): Promise<ApiListItem<ResourceManagerOperations["list_resource_groups"], "resources">[]> {
  const accountId = await api.accountId();
  const res = await api.resourceManager.get("/v2/resource_groups", {
    query: { account_id: accountId },
  });
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

type VpcSchemas = VpcComponents["schemas"];

export type VpcInstance = VpcSchemas["Instance"];

/** A floating IP as a mapper reads it: what its target is depends on what it is bound to. */
type FloatingIp = Omit<VpcSchemas["FloatingIP"], "target"> & {
  target?: { id?: string; name?: string; href?: string } | null | undefined;
};

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

function listFloatingIpsIn(api: IbmApi, region: string): Promise<FloatingIp[]> {
  return vpcList(
    (paging) => api.vpc(region).get("/floating_ips", { query: { ...VPC_LIST_QUERY, ...paging } }),
    (p) => p.floating_ips,
  );
}

async function floatingByNic(api: IbmApi, region: string): Promise<Map<string, string>> {
  const ips = await listFloatingIpsIn(api, region).catch((): FloatingIp[] => []);
  const byNic = new Map<string, string>();
  for (const f of ips) if (f.target?.id && f.address) byNic.set(f.target.id, f.address);
  return byNic;
}

export async function listInstances(ctx: ListContext): Promise<ResourceInstance[]> {
  return perRegion(ctx, await vpcRegions(ctx), async (region) => {
    const [instances, floating] = await Promise.all([
      vpcList(
        (paging) =>
          ctx.api.vpc(region).get("/instances", { query: { ...VPC_LIST_QUERY, ...paging } }),
        (p) => p.instances,
      ),
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
    ctx.api.vpc(region).get(`/instances/${pathEncode(id)}`, { query: VPC_QUERY }),
    floatingByNic(ctx.api, region),
  ]);
  return mapInstance(ctx.accountId, region, i, floating);
}

export async function listVolumes(ctx: ListContext): Promise<ResourceInstance[]> {
  return perRegion(ctx, await vpcRegions(ctx), async (region) =>
    (
      await vpcList(
        (paging) =>
          ctx.api.vpc(region).get("/volumes", { query: { ...VPC_LIST_QUERY, ...paging } }),
        (p) => p.volumes,
      )
    ).map((v) =>
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
  return perRegion(ctx, await vpcRegions(ctx), async (region) =>
    (
      await vpcList(
        (paging) => ctx.api.vpc(region).get("/vpcs", { query: { ...VPC_LIST_QUERY, ...paging } }),
        (p) => p.vpcs,
      )
    ).map((v) =>
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
  return perRegion(ctx, await vpcRegions(ctx), async (region) =>
    (
      await vpcList(
        (paging) =>
          ctx.api.vpc(region).get("/subnets", { query: { ...VPC_LIST_QUERY, ...paging } }),
        (p) => p.subnets,
      )
    ).map((s) =>
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
  return perRegion(ctx, await vpcRegions(ctx), async (region) =>
    (
      await vpcList(
        (paging) =>
          ctx.api.vpc(region).get("/security_groups", { query: { ...VPC_LIST_QUERY, ...paging } }),
        (p) => p.security_groups,
      )
    ).map((g) => {
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
    (await listFloatingIpsIn(ctx.api, region)).map((f) =>
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
  return perRegion(ctx, await vpcRegions(ctx), async (region) =>
    (
      await vpcList(
        (paging) =>
          ctx.api.vpc(region).get("/load_balancers", { query: { ...VPC_LIST_QUERY, ...paging } }),
        (p) => p.load_balancers,
      )
    ).map((l) =>
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

/** Every key of a region, which a create also looks through. */
export function listKeysIn(api: IbmApi, region: string) {
  return vpcList(
    (paging) => api.vpc(region).get("/keys", { query: { ...VPC_LIST_QUERY, ...paging } }),
    (p) => p.keys,
  );
}

export async function listKeys(ctx: ListContext): Promise<ResourceInstance[]> {
  return perRegion(ctx, await vpcRegions(ctx), async (region) =>
    (await listKeysIn(ctx.api, region)).map((k) =>
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

type Cluster = ApiListItem<ContainersOperations["vpcGetClusters"], null>;

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
    ctx.api.containers.get("/v2/vpc/getClusters", { query: { provider: "vpc-gen2" } }),
    ctx.api.containers.get("/v2/classic/getClusters").catch((err: unknown): Cluster[] => {
      if (isPermissionGap(err)) return [];
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
  const c = await ctx.api.containers.get("/v2/getCluster", { query: { cluster: id } });
  return mapCluster(ctx.accountId, c);
}

export async function poolsOf(ctx: ListContext, clusterId: string): Promise<ResourceInstance[]> {
  const pools = await ctx.api.containers.get("/v2/getWorkerPools", {
    query: { cluster: clusterId },
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
      poolsOf(ctx, c.externalId!).catch((err: unknown): ResourceInstance[] => {
        if (isPermissionGap(err)) return [];
        throw err;
      }),
    )
  ).flat();
}

// ---------------------------------------------------------------------------
// Code Engine

type CeSchemas = CodeEngineComponents["schemas"];

/** What a create form knows of a project is less than a list row. */
type CeProject = Pick<CeSchemas["Project"], "id" | "name"> &
  Partial<Pick<CeSchemas["Project"], "status" | "resource_group_id" | "created_at">>;

/** Page a Code Engine list, by the `start` in each page's `next`. */
async function ceList<Page extends { next?: { start?: string } }, Item>(
  page: (query: { limit: number; start?: string }) => Promise<Page>,
  items: (page: Page) => readonly Item[] | undefined,
): Promise<Item[]> {
  const out: Item[] = [];
  let start: string | undefined;
  for (let n = 0; n < 50; n++) {
    const res = await page({ limit: 100, ...(start ? { start } : {}) });
    out.push(...(items(res) ?? []));
    start = res.next?.start;
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

function ceProjects(api: IbmApi, region: string) {
  return ceList(
    (query) => api.codeEngine(region).get("/projects", { query }),
    (p) => p.projects,
  );
}

export async function listProjects(ctx: ListContext): Promise<ResourceInstance[]> {
  return perRegion(ctx, await ceRegions(ctx), async (region) =>
    (await ceProjects(ctx.api, region)).map((p) => mapProject(ctx.accountId, region, p)),
  );
}

export type CeApp = ApiResponse<CodeEngineOperations["get_app"]>;

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
    const projects = await ceProjects(ctx.api, region);
    const apps = await mapLimit(projects, 4, async (p) =>
      (
        await ceList(
          (query) =>
            ctx.api.codeEngine(region).get(`/projects/${pathEncode(p.id)}/apps`, { query }),
          (page) => page.apps,
        )
      ).map((a) => mapApp(ctx.accountId, region, p.id, a)),
    );
    return apps.flat();
  });
}

// ---------------------------------------------------------------------------
// Resource Controller (service instances, databases, COS)

export type ResourceInstanceRc = ResourceControllerComponents["schemas"]["ResourceInstance"];

type ResourceInstanceList = ApiResponse<ResourceControllerOperations["list_resource_instances"]>;

export async function resourceInstances(api: IbmApi): Promise<ResourceInstanceRc[]> {
  const out: ResourceInstanceRc[] = [];
  let res = await api.resourceController.get("/v2/resource_instances", { query: { limit: 100 } });
  for (let page = 1; ; page++) {
    out.push(...(res.resources ?? []));
    if (!res.next_url || page === 100) return out;
    // The next link is a path on this host, which an old loop concatenated.
    res = await api.followLink<ResourceInstanceList>(`${RESOURCE_CONTROLLER}${res.next_url}`);
  }
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

type DbGroup = ApiListItem<DatabasesOperations["listDeploymentScalingGroups"], "groups">;

export async function databaseGroups(api: IbmApi, region: string, crn: string): Promise<DbGroup[]> {
  const res = await api.databases(region).get(`/deployments/${pathEncode(crn)}/groups`);
  return res.groups ?? [];
}

export async function databaseResource(
  ctx: ListContext,
  r: ResourceInstanceRc,
): Promise<ResourceInstance> {
  const crn = r.crn ?? r.id;
  const region = r.region_id || DEFAULT_REGION;
  const [info, groups] = await Promise.all([
    ctx.api
      .databases(region)
      .get(`/deployments/${pathEncode(crn)}`)
      .catch(() => undefined),
    databaseGroups(ctx.api, region, crn).catch((): DbGroup[] => []),
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
    const xml = await ctx.api.requestXml({
      // The extended listing adds each bucket's LocationConstraint; any
      // endpoint lists every bucket of the instance.
      url: `https://${cosEndpoint("us")}/?extended`,
      headers: { "ibm-service-instance-id": inst.guid!, accept: "application/xml" },
    });
    return parseBucketList(xml).map((b) => ({ ...b, instance: inst.guid! }));
  });
  const buckets = perInstance.flat();
  return mapLimit(buckets, 6, async (b) => {
    const config = await ctx.api.cosConfig.get(`/b/${pathEncode(b.name)}`).catch(() => undefined);
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
