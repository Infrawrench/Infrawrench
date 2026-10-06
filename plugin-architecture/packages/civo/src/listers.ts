/**
 * Listing: Civo API objects to `ResourceInstance`s. Regional listers fan out
 * across the account's regions (each region one request, at most four in
 * flight); a region that fails is skipped rather than failing the whole
 * list, because an out-of-capacity or newly launched region should not hide
 * every other region's resources.
 *
 * Fields an orphan/posture rule reads are always written (empty string, never
 * absent).
 */

import type { ResourceInstance } from "@infrawrench/plugin-base";
import { type CivoApi, mapPooled } from "./api.js";
import type { RegionCache, RegionFeature } from "./regions.js";
import type {
  CivoCluster,
  CivoDatabase,
  CivoDatabaseBackup,
  CivoDnsDomain,
  CivoDnsRecord,
  CivoFirewall,
  CivoFirewallRule,
  CivoInstance,
  CivoInstanceSnapshot,
  CivoIp,
  CivoLoadBalancer,
  CivoNetwork,
  CivoObjectStore,
  CivoObjectStoreCredential,
  CivoPool,
  CivoQuota,
  CivoSshKey,
  CivoVolume,
  CivoVolumeSnapshot,
} from "./types.js";

export const PLUGIN_ID = "civo";

type Fields = Record<string, string | number | boolean>;

export interface ListContext {
  api: CivoApi;
  regions: RegionCache;
}

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Fields,
  opts: { outputs?: Record<string, string>; parentResourceId?: string; created?: string } = {},
): ResourceInstance {
  const now = new Date().toISOString();
  const created = opts.created && !Number.isNaN(Date.parse(opts.created)) ? opts.created : now;
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields,
    resolvedOutputs: opts.outputs ?? {},
    secretStates: [],
    externalId,
    ...(opts.parentResourceId ? { parentResourceId: opts.parentResourceId } : {}),
    createdAt: created,
    updatedAt: created,
  };
}

const str = (v: unknown) => (v == null ? "" : String(v));
const lower = (v: unknown) => str(v).toLowerCase();

/** Run a per-region list across every region with the feature. */
export async function perRegion<T>(
  ctx: ListContext,
  feature: RegionFeature | undefined,
  fn: (region: string) => Promise<T[]>,
): Promise<Array<{ region: string; item: T }>> {
  const codes = await ctx.regions.codes(feature);
  const settled = await mapPooled(codes, 4, async (region) => {
    try {
      return (await fn(region)).map((item) => ({ region, item }));
    } catch {
      return [];
    }
  });
  return settled.flat();
}

// --- Instances ---------------------------------------------------------------

export function mapInstance(i: CivoInstance, region: string, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "instance",
    `${region}/${i.id}`,
    str(i.hostname),
    {
      hostname: str(i.hostname),
      status: str(i.status),
      size: str(i.size),
      region: lower(i.region || region),
      diskImage: str(i.source_id),
      cpuCores: i.cpu_cores ?? 0,
      ramMb: i.ram_mb ?? 0,
      diskGb: i.disk_gb ?? 0,
      gpu: i.gpu_count ? `${i.gpu_count} × ${str(i.gpu_type)}` : "",
      initialUser: str(i.initial_user),
      firewallId: str(i.firewall_id),
      networkId: str(i.network_id),
      reservedIp: str(i.reserved_ip),
      reverseDns: str(i.reverse_dns),
      notes: str(i.notes),
      allowedIps: (i.allowed_ips ?? []).join(", "),
      bandwidthLimit: i.network_bandwidth_limit ?? 0,
      tags: (i.tags ?? []).join(", "),
      created: str(i.created_at),
    },
    {
      outputs: {
        ipv4: str(i.public_ip),
        ipv4Private: str(i.private_ip),
        ipv6: str(i.ipv6),
        instanceId: i.id,
        instanceRef: `${region}/${i.id}`,
      },
      ...(i.created_at ? { created: i.created_at } : {}),
    },
  );
}

export async function listInstances(ctx: ListContext, accountId: string) {
  const rows = await perRegion(ctx, "iaas", (region) =>
    ctx.api.list<CivoInstance>("/instances", { region }),
  );
  return rows.map(({ region, item }) => mapInstance(item, region, accountId));
}

// --- Volumes and snapshots ------------------------------------------------------

export function mapVolume(v: CivoVolume, region: string, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "volume",
    `${region}/${v.id}`,
    str(v.name),
    {
      name: str(v.name),
      sizeGb: v.size_gb ?? 0,
      region: lower(region),
      status: str(v.status),
      volumeType: str(v.volume_type),
      instanceId: str(v.instance_id),
      clusterId: str(v.cluster_id),
      mountPoint: str(v.mountpoint),
      networkId: str(v.network_id),
      created: str(v.created_at),
    },
    {
      outputs: { volumeId: v.id, volumeRef: `${region}/${v.id}` },
      ...(v.created_at ? { created: v.created_at } : {}),
    },
  );
}

export async function listVolumes(ctx: ListContext, accountId: string) {
  const rows = await perRegion(ctx, "volume", (region) =>
    ctx.api.list<CivoVolume>("/volumes", { region }),
  );
  return rows.map(({ region, item }) => mapVolume(item, region, accountId));
}

export function mapVolumeSnapshot(
  s: CivoVolumeSnapshot,
  region: string,
  accountId: string,
): ResourceInstance {
  return instance(
    accountId,
    "volume-snapshot",
    `${region}/${s.snapshot_id}`,
    str(s.name) || s.snapshot_id,
    {
      name: str(s.name),
      description: str(s.snapshot_description),
      volumeId: str(s.volume_id),
      sourceVolumeName: str(s.source_volume_name),
      sourceRef: s.volume_id ? `${region}/${s.volume_id}` : "",
      state: str(s.state),
      sizeGb: s.restore_size ?? 0,
      createdAt: str(s.creation_time),
      region: lower(region),
    },
    s.creation_time ? { created: s.creation_time } : {},
  );
}

export async function listVolumeSnapshots(ctx: ListContext, accountId: string) {
  const rows = await perRegion(ctx, "volume", (region) =>
    ctx.api.list<CivoVolumeSnapshot>("/snapshots", { region, resource_type: "volume" }),
  );
  return rows.map(({ region, item }) => mapVolumeSnapshot(item, region, accountId));
}

export function mapInstanceSnapshot(
  s: CivoInstanceSnapshot,
  instanceId: string,
  region: string,
  accountId: string,
): ResourceInstance {
  return instance(
    accountId,
    "instance-snapshot",
    `${region}/${instanceId}/${s.id}`,
    str(s.name) || s.id,
    {
      name: str(s.name),
      description: str(s.description),
      instanceId,
      sourceRef: `${region}/${instanceId}`,
      state: str(s.status?.state),
      createdAt: str(s.created_at),
      region: lower(region),
    },
    s.created_at ? { created: s.created_at } : {},
  );
}

export async function listInstanceSnapshots(ctx: ListContext, accountId: string) {
  const instances = await perRegion(ctx, "iaas", (region) =>
    ctx.api.list<CivoInstance>("/instances", { region }),
  );
  const rows = await mapPooled(instances, 4, async ({ region, item }) => {
    try {
      const snaps = await ctx.api.list<CivoInstanceSnapshot>(`/instances/${item.id}/snapshots`, {
        region,
      });
      return snaps.map((s) => mapInstanceSnapshot(s, item.id, region, accountId));
    } catch {
      return [];
    }
  });
  return rows.flat();
}

// --- Kubernetes ------------------------------------------------------------------

export function mapCluster(c: CivoCluster, region: string, accountId: string): ResourceInstance {
  const pools = c.pools ?? [];
  const nodeCount = pools.length
    ? pools.reduce((s, p) => s + (p.count ?? 0), 0)
    : (c.num_target_nodes ?? 0);
  return instance(
    accountId,
    "kubernetes-cluster",
    `${region}/${c.id}`,
    str(c.name),
    {
      name: str(c.name),
      region: lower(region),
      version: str(c.kubernetes_version || c.version),
      upgradeAvailableTo: str(c.upgrade_available_to),
      clusterType: str(c.cluster_type),
      cniPlugin: str(c.cni_plugin),
      status: str(c.status),
      nodeCount,
      nodeSize: str(pools[0]?.size || c.target_nodes_size),
      poolCount: pools.length,
      apiEndpoint: str(c.api_endpoint),
      masterIp: str(c.master_ip),
      firewallId: str(c.firewall_id),
      networkId: str(c.network_id),
      applications: (c.installed_applications ?? [])
        .map((a) => a.application || a.name)
        .filter(Boolean)
        .join(", "),
      tags: (c.tags ?? []).join(", "),
      created: str(c.created_at),
    },
    {
      outputs: {
        apiEndpoint: str(c.api_endpoint),
        clusterId: c.id,
        clusterRef: `${region}/${c.id}`,
      },
      ...(c.created_at ? { created: c.created_at } : {}),
    },
  );
}

export function mapPool(
  p: CivoPool,
  cluster: CivoCluster,
  region: string,
  accountId: string,
): ResourceInstance {
  return instance(
    accountId,
    "node-pool",
    `${region}/${cluster.id}/${p.id}`,
    `${str(cluster.name)} / ${p.id}`,
    {
      poolId: p.id,
      size: str(p.size),
      count: p.count ?? 0,
      publicIpNodePool: p.public_ip_node_pool === true,
      nodesActive: (p.instances ?? []).filter((i) => (i.status ?? "").toUpperCase() === "ACTIVE")
        .length,
      clusterId: cluster.id,
      region: lower(region),
    },
    { parentResourceId: `${accountId}:kubernetes-cluster:${region}/${cluster.id}` },
  );
}

async function clusters(ctx: ListContext) {
  return perRegion(ctx, "kubernetes", (region) =>
    ctx.api.list<CivoCluster>("/kubernetes/clusters", { region }),
  );
}

export async function listClusters(ctx: ListContext, accountId: string) {
  return (await clusters(ctx)).map(({ region, item }) => mapCluster(item, region, accountId));
}

export async function listPools(ctx: ListContext, accountId: string) {
  return (await clusters(ctx)).flatMap(({ region, item }) =>
    (item.pools ?? []).map((p) => mapPool(p, item, region, accountId)),
  );
}

// --- Databases ----------------------------------------------------------------------

export function engineLabel(software: string | undefined): string {
  const s = (software ?? "").toLowerCase();
  if (s.startsWith("postgres")) return "PostgreSQL";
  if (s.startsWith("mysql")) return "MySQL";
  return software ?? "";
}

export function mapDatabase(d: CivoDatabase, region: string, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "database",
    `${region}/${d.id}`,
    str(d.name),
    {
      name: str(d.name),
      engine: engineLabel(d.software),
      version: str(d.software_version),
      region: lower(region),
      status: str(d.status),
      size: str(d.size),
      nodes: d.nodes ?? 1,
      host: str(d.dns_entry || d.public_ipv4),
      privateHost: str(d.private_ipv4),
      port: d.port ?? 0,
      firewallId: str(d.firewall_id),
      networkId: str(d.network_id),
    },
    {
      outputs: {
        host: str(d.dns_entry || d.public_ipv4),
        port: str(d.port ?? ""),
        username: str(d.username),
        databaseId: d.id,
        databaseRef: `${region}/${d.id}`,
      },
    },
  );
}

export async function listDatabases(ctx: ListContext, accountId: string) {
  const rows = await perRegion(ctx, "dbaas", (region) =>
    ctx.api.list<CivoDatabase>("/databases", { region }),
  );
  return rows.map(({ region, item }) => mapDatabase(item, region, accountId));
}

export function mapDatabaseBackup(
  b: CivoDatabaseBackup,
  databaseId: string,
  region: string,
  accountId: string,
): ResourceInstance {
  const id = b.id || b.name || "";
  return instance(
    accountId,
    "database-backup",
    `${region}/${databaseId}/${id}`,
    str(b.name) || id,
    {
      name: str(b.name),
      schedule: str(b.schedule),
      scheduled: b.is_scheduled === true,
      status: str(b.status),
      databaseId,
      sourceRef: `${region}/${databaseId}`,
      createdAt: str(b.created_at),
      region: lower(region),
    },
    {
      parentResourceId: `${accountId}:database:${region}/${databaseId}`,
      ...(b.created_at ? { created: b.created_at } : {}),
    },
  );
}

export async function listDatabaseBackups(ctx: ListContext, accountId: string) {
  const dbs = await perRegion(ctx, "dbaas", (region) =>
    ctx.api.list<CivoDatabase>("/databases", { region }),
  );
  const rows = await mapPooled(dbs, 4, async ({ region, item }) => {
    try {
      const backups = await ctx.api.list<CivoDatabaseBackup>(`/databases/${item.id}/backups`, {
        region,
      });
      return backups.map((b) => mapDatabaseBackup(b, item.id, region, accountId));
    } catch {
      return [];
    }
  });
  return rows.flat();
}

// --- Networking ----------------------------------------------------------------------

export function mapLoadBalancer(
  lb: CivoLoadBalancer,
  region: string,
  accountId: string,
): ResourceInstance {
  const backends = lb.backends ?? [];
  const poolNames = (lb.instance_pools ?? []).flatMap((p) => [
    ...(p.names ?? []),
    ...(p.tags ?? []),
  ]);
  return instance(
    accountId,
    "load-balancer",
    `${region}/${lb.id}`,
    str(lb.name),
    {
      name: str(lb.name),
      region: lower(region),
      state: str(lb.state),
      algorithm: str(lb.algorithm),
      publicIp: str(lb.reserved_ip || lb.public_ip),
      privateIp: str(lb.private_ip),
      backendCount: backends.length + poolNames.length,
      backends: [
        ...backends.map(
          (b) =>
            `${str(b.ip)}:${str(b.target_port)} (${str(b.protocol || "TCP")} ${str(b.source_port)})`,
        ),
        ...poolNames,
      ].join(", "),
      externalTrafficPolicy: str(lb.external_traffic_policy),
      sessionAffinity: str(lb.session_affinity),
      proxyProtocol: str(lb.enable_proxy_protocol),
      maxConcurrentRequests: lb.max_concurrent_requests ?? 0,
      clusterId: str(lb.cluster_id),
      firewallId: str(lb.firewall_id),
      networkId: str(lb.network_id),
    },
    { outputs: { ipv4: str(lb.reserved_ip || lb.public_ip) } },
  );
}

export async function listLoadBalancers(ctx: ListContext, accountId: string) {
  const rows = await perRegion(ctx, "loadbalancer", (region) =>
    ctx.api.list<CivoLoadBalancer>("/loadbalancers", { region }),
  );
  return rows.map(({ region, item }) => mapLoadBalancer(item, region, accountId));
}

const WEB = new Set(["80", "443"]);

/** Ingress ports a firewall allows from anywhere, other than 80/443. */
export function openToWorld(rules: CivoFirewallRule[]): string {
  const open = new Set<string>();
  for (const r of rules) {
    if ((r.direction ?? "ingress") !== "ingress" || (r.action ?? "allow") !== "allow") continue;
    if (!(r.cidr ?? []).some((c) => c === "0.0.0.0/0" || c === "::/0")) continue;
    const proto = (r.protocol ?? "tcp").toLowerCase();
    if (proto === "icmp") continue;
    const ports =
      r.ports ||
      (r.start_port
        ? r.end_port && r.end_port !== r.start_port
          ? `${r.start_port}-${r.end_port}`
          : r.start_port
        : "all");
    if (WEB.has(ports)) continue;
    open.add(`${proto}/${ports}`);
  }
  return [...open].sort().join(", ");
}

export function mapFirewall(fw: CivoFirewall, region: string, accountId: string): ResourceInstance {
  const fields: Fields = {
    name: str(fw.name),
    region: lower(region),
    networkId: str(fw.network_id),
    rulesCount: fw.rules_count ?? fw.rules?.length ?? 0,
    instanceCount: fw.instance_count ?? 0,
    clusterCount: fw.cluster_count ?? 0,
    loadBalancerCount: fw.loadbalancer_count ?? 0,
  };
  if (fw.rules) fields["openToWorld"] = openToWorld(fw.rules);
  return instance(accountId, "firewall", `${region}/${fw.id}`, str(fw.name), fields, {
    outputs: { firewallId: fw.id },
  });
}

export async function listFirewalls(ctx: ListContext, accountId: string) {
  const rows = await perRegion(ctx, "iaas", (region) =>
    ctx.api.list<CivoFirewall>("/firewalls", { region }),
  );
  return mapPooled(rows, 4, async ({ region, item }) => {
    if (!item.rules) {
      try {
        item.rules = await ctx.api.list<CivoFirewallRule>(`/firewalls/${item.id}/rules`, {
          region,
        });
      } catch {
        // leave rules unknown: openToWorld stays absent
      }
    }
    return mapFirewall(item, region, accountId);
  });
}

export function mapNetwork(n: CivoNetwork, region: string, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "network",
    `${region}/${n.id}`,
    str(n.label || n.name),
    {
      label: str(n.label || n.name),
      region: lower(region),
      cidr: str(n.cidr),
      default: n.default === true,
      status: str(n.status),
      nameservers: (n.nameservers_v4 ?? []).join(", "),
      freeIps: n.free_ip_count ?? 0,
    },
    { outputs: { networkId: n.id } },
  );
}

export async function listNetworks(ctx: ListContext, accountId: string) {
  const rows = await perRegion(ctx, "iaas", (region) =>
    ctx.api.list<CivoNetwork>("/networks", { region }),
  );
  return rows.map(({ region, item }) => mapNetwork(item, region, accountId));
}

export function mapIp(ip: CivoIp, region: string, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "reserved-ip",
    `${region}/${ip.id}`,
    str(ip.name) || str(ip.ip),
    {
      name: str(ip.name),
      address: str(ip.ip),
      region: lower(region),
      assignedToId: str(ip.assigned_to?.id),
      assignedToType: str(ip.assigned_to?.type),
      assignedToName: str(ip.assigned_to?.name),
    },
    { outputs: { ip: str(ip.ip) } },
  );
}

export async function listIps(ctx: ListContext, accountId: string) {
  const rows = await perRegion(ctx, "iaas", (region) => ctx.api.list<CivoIp>("/ips", { region }));
  return rows.map(({ region, item }) => mapIp(item, region, accountId));
}

// --- DNS ---------------------------------------------------------------------------

export function mapDomain(
  d: CivoDnsDomain,
  accountId: string,
  recordCount: number | null,
): ResourceInstance {
  const fields: Fields = { name: d.name };
  if (recordCount !== null) fields["recordCount"] = recordCount;
  return instance(accountId, "domain", d.id, d.name, fields, {
    outputs: { nameservers: "ns0.civo.com, ns1.civo.com" },
  });
}

export function mapDnsRecord(
  r: CivoDnsRecord,
  domain: CivoDnsDomain,
  accountId: string,
): ResourceInstance {
  return instance(
    accountId,
    "dns-record",
    `${domain.id}/${r.id}`,
    `${str(r.name) || "@"} ${str(r.type).toUpperCase()}`,
    {
      type: str(r.type).toUpperCase(),
      name: str(r.name),
      value: str(r.value),
      ttl: r.ttl ?? 0,
      priority: r.priority ?? 0,
      domainName: domain.name,
    },
    {
      parentResourceId: `${accountId}:domain:${domain.id}`,
      ...(r.created_at ? { created: r.created_at } : {}),
    },
  );
}

export async function listDomains(ctx: ListContext, accountId: string) {
  const domains = await ctx.api.list<CivoDnsDomain>("/dns");
  return mapPooled(domains, 4, async (d) => {
    let count: number | null = null;
    try {
      count = (await ctx.api.list<CivoDnsRecord>(`/dns/${d.id}/records`)).length;
    } catch {
      count = null;
    }
    return mapDomain(d, accountId, count);
  });
}

export async function listDnsRecords(ctx: ListContext, accountId: string) {
  const domains = await ctx.api.list<CivoDnsDomain>("/dns");
  const rows = await mapPooled(domains, 4, async (d) => {
    try {
      return (await ctx.api.list<CivoDnsRecord>(`/dns/${d.id}/records`)).map((r) =>
        mapDnsRecord(r, d, accountId),
      );
    } catch {
      return [];
    }
  });
  return rows.flat();
}

// --- Object storage ------------------------------------------------------------------

export function bucketUrl(store: CivoObjectStore): string {
  const endpoint = str(store.objectstore_endpoint).replace(/\/+$/, "");
  if (!endpoint) return "";
  const base = endpoint.startsWith("http") ? endpoint : `https://${endpoint}`;
  return `${base}/${str(store.name)}`;
}

export function mapObjectStore(
  s: CivoObjectStore,
  region: string,
  accountId: string,
): ResourceInstance {
  const endpoint = str(s.objectstore_endpoint);
  return instance(
    accountId,
    "object-store",
    `${region}/${s.id}`,
    str(s.name),
    {
      name: str(s.name),
      region: lower(region),
      maxSizeGb: s.max_size ?? 0,
      status: str(s.status),
      endpoint,
      credentialId: str(s.owner_info?.credential_id),
      accessKeyId: str(s.owner_info?.access_key_id),
    },
    {
      outputs: {
        endpoint: endpoint ? (endpoint.startsWith("http") ? endpoint : `https://${endpoint}`) : "",
        bucketUrl: bucketUrl(s),
        accessKey: str(s.owner_info?.access_key_id),
      },
    },
  );
}

export async function listObjectStores(ctx: ListContext, accountId: string) {
  const rows = await perRegion(ctx, "object_store", (region) =>
    ctx.api.list<CivoObjectStore>("/objectstores", { region }),
  );
  return rows.map(({ region, item }) => mapObjectStore(item, region, accountId));
}

export function mapCredential(
  c: CivoObjectStoreCredential,
  region: string,
  accountId: string,
): ResourceInstance {
  return instance(
    accountId,
    "object-store-credential",
    `${region}/${c.id}`,
    str(c.name),
    {
      name: str(c.name),
      region: lower(region),
      accessKeyId: str(c.access_key_id),
      status: str(c.status),
      suspended: c.suspended === true,
    },
    { outputs: { credentialId: c.id, accessKey: str(c.access_key_id) } },
  );
}

export async function listCredentials(ctx: ListContext, accountId: string) {
  const rows = await perRegion(ctx, "object_store", (region) =>
    ctx.api.list<CivoObjectStoreCredential>("/objectstore/credentials", { region }),
  );
  return rows.map(({ region, item }) => mapCredential(item, region, accountId));
}

// --- Account-wide ----------------------------------------------------------------------

export function mapSshKey(k: CivoSshKey, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "ssh-key",
    k.id,
    str(k.name),
    {
      name: str(k.name),
      fingerprint: str(k.fingerprint),
      publicKey: str(k.public_key),
      created: str(k.created_at),
    },
    { outputs: { sshKeyId: k.id }, ...(k.created_at ? { created: k.created_at } : {}) },
  );
}

export async function listSshKeys(ctx: ListContext, accountId: string) {
  return (await ctx.api.list<CivoSshKey>("/sshkeys")).map((k) => mapSshKey(k, accountId));
}

const pair = (q: CivoQuota, key: string) => {
  const used = q[`${key}_usage`];
  const limit = q[`${key}_limit`];
  return used === undefined && limit === undefined ? "" : `${str(used ?? 0)} / ${str(limit ?? 0)}`;
};

export function mapAccount(q: CivoQuota, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "account",
    "account",
    str(q["default_user_email_address"]) || "Civo account",
    {
      email: str(q["default_user_email_address"]),
      instances: pair(q, "instance_count"),
      cpuCores: pair(q, "cpu_core"),
      ramMb: pair(q, "ram_mb"),
      diskGb: pair(q, "disk_gb"),
      publicIps: pair(q, "public_ip_address"),
      loadBalancers: pair(q, "loadbalancer_count"),
      objectStoreGb: pair(q, "objectstore_gb"),
      databases: pair(q, "database_count"),
    },
  );
}

export async function listAccount(ctx: ListContext, accountId: string) {
  return [mapAccount(await ctx.api.get<CivoQuota>("/quota"), accountId)];
}
