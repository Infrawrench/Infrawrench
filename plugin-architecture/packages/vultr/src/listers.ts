/**
 * Listing: Vultr API objects to `ResourceInstance`s.
 *
 * Every lister writes the fields its type's `orphanRule` / `postureChecks`
 * read unconditionally (an empty string, never absent), so a rule written as
 * `equals ""` means what it says. A count that needs a follow-up request is
 * left absent when that request fails: `equals` never matches an absent
 * field, so a flaky call cannot flag a healthy resource.
 */

import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { VultrApi } from "./api.js";
import type {
  VultrAccount,
  VultrBackup,
  VultrBareMetal,
  VultrBlock,
  VultrDatabase,
  VultrDatabaseUser,
  VultrDomain,
  VultrDomainRecord,
  VultrFirewallGroup,
  VultrFirewallRule,
  VultrInstance,
  VultrInvoice,
  VultrKubernetesCluster,
  VultrLoadBalancer,
  VultrNodePool,
  VultrObjectStorage,
  VultrReservedIp,
  VultrSnapshot,
  VultrSshKey,
  VultrStartupScript,
  VultrVpc,
} from "./types.js";

export const PLUGIN_ID = "vultr";

type Fields = Record<string, string | number | boolean>;

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

/** Run `fn` over `items` with at most `limit` requests in flight. */
export async function mapPooled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

const str = (v: unknown) => (v == null ? "" : String(v));
const joinTags = (t: string[] | undefined) => (t ?? []).join(", ");

// --- Instances ---------------------------------------------------------------

export function mapInstance(i: VultrInstance, accountId: string): ResourceInstance {
  const features = i.features ?? [];
  const privateIp = i.internal_ip && i.internal_ip !== "0.0.0.0" ? i.internal_ip : "";
  const publicIp = i.main_ip && i.main_ip !== "0.0.0.0" ? i.main_ip : "";
  return instance(
    accountId,
    "instance",
    i.id,
    str(i.label) || str(i.hostname),
    {
      label: str(i.label),
      hostname: str(i.hostname),
      status: str(i.status),
      powerStatus: str(i.power_status),
      serverStatus: str(i.server_status),
      plan: str(i.plan),
      region: str(i.region),
      os: str(i.os),
      vcpus: i.vcpu_count ?? 0,
      ramMb: i.ram ?? 0,
      diskGb: i.disk ?? 0,
      bandwidthGb: i.allowed_bandwidth ?? 0,
      backupsEnabled: features.includes("auto_backups"),
      ddosProtection: features.includes("ddos_protection"),
      ipv6Enabled: features.includes("ipv6"),
      firewallGroupId: str(i.firewall_group_id),
      vpcOnly: i.vpc_only === true,
      tags: joinTags(i.tags),
      created: str(i.date_created),
    },
    {
      outputs: {
        ipv4: publicIp,
        ipv4Private: privateIp,
        ipv6: str(i.v6_main_ip),
        instanceId: i.id,
      },
      ...(i.date_created ? { created: i.date_created } : {}),
    },
  );
}

export async function listInstances(api: VultrApi, accountId: string) {
  return (await api.all<VultrInstance>("/instances", "instances")).map((i) =>
    mapInstance(i, accountId),
  );
}

export function mapBareMetal(b: VultrBareMetal, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "bare-metal",
    b.id,
    str(b.label),
    {
      label: str(b.label),
      status: str(b.status),
      powerStatus: str(b.power_status),
      plan: str(b.plan),
      region: str(b.region),
      os: str(b.os),
      cpuCount: b.cpu_count ?? 0,
      ram: str(b.ram),
      disk: str(b.disk),
      tags: joinTags(b.tags),
      created: str(b.date_created),
    },
    {
      outputs: { ipv4: str(b.main_ip), ipv6: str(b.v6_main_ip) },
      ...(b.date_created ? { created: b.date_created } : {}),
    },
  );
}

export async function listBareMetal(api: VultrApi, accountId: string) {
  return (await api.all<VultrBareMetal>("/bare-metals", "bare_metals")).map((b) =>
    mapBareMetal(b, accountId),
  );
}

// --- Block storage, snapshots, backups ------------------------------------------

export function mapBlock(b: VultrBlock, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "block-storage",
    b.id,
    str(b.label) || `Volume ${b.id.slice(0, 8)}`,
    {
      label: str(b.label),
      sizeGb: b.size_gb ?? 0,
      region: str(b.region),
      blockType: str(b.block_type),
      status: str(b.status),
      attachedInstanceId: str(b.attached_to_instance),
      attachedInstanceLabel: str(b.attached_to_instance_label),
      mountId: str(b.mount_id),
      monthlyCost: b.cost ?? 0,
      created: str(b.date_created),
    },
    {
      outputs: { mountId: str(b.mount_id) },
      ...(b.date_created ? { created: b.date_created } : {}),
    },
  );
}

export async function listBlocks(api: VultrApi, accountId: string) {
  return (await api.all<VultrBlock>("/blocks", "blocks")).map((b) => mapBlock(b, accountId));
}

const gb = (bytes: number | undefined) => Math.round(((bytes ?? 0) / 1024 ** 3) * 100) / 100;

export function mapSnapshot(s: VultrSnapshot, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "snapshot",
    s.id,
    str(s.description) || `Snapshot ${s.id.slice(0, 8)}`,
    {
      description: str(s.description),
      status: str(s.status),
      sizeGb: gb(s.size),
      compressedSizeGb: gb(s.compressed_size),
      osId: s.os_id ?? 0,
      createdAt: str(s.date_created),
    },
    { outputs: { snapshotId: s.id }, ...(s.date_created ? { created: s.date_created } : {}) },
  );
}

export async function listSnapshots(api: VultrApi, accountId: string) {
  return (await api.all<VultrSnapshot>("/snapshots", "snapshots")).map((s) =>
    mapSnapshot(s, accountId),
  );
}

export function mapBackup(b: VultrBackup, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "backup",
    b.id,
    str(b.description) || `Backup ${b.id.slice(0, 8)}`,
    {
      description: str(b.description),
      status: str(b.status),
      sizeGb: gb(b.size),
      createdAt: str(b.date_created),
    },
    { outputs: { backupId: b.id }, ...(b.date_created ? { created: b.date_created } : {}) },
  );
}

export async function listBackups(api: VultrApi, accountId: string) {
  return (await api.all<VultrBackup>("/backups", "backups")).map((b) => mapBackup(b, accountId));
}

// --- Kubernetes ----------------------------------------------------------------

export function mapCluster(c: VultrKubernetesCluster, accountId: string): ResourceInstance {
  const pools = c.node_pools ?? [];
  const biggest = [...pools].sort((a, b) => (b.node_quantity ?? 0) - (a.node_quantity ?? 0))[0];
  return instance(
    accountId,
    "kubernetes-cluster",
    c.id,
    str(c.label),
    {
      label: str(c.label),
      region: str(c.region),
      version: str(c.version),
      status: str(c.status),
      haControlPlanes: c.ha_controlplanes === true,
      firewallGroupId: str(c.firewall_group_id),
      endpoint: str(c.endpoint),
      clusterSubnet: str(c.cluster_subnet),
      serviceSubnet: str(c.service_subnet),
      poolCount: pools.length,
      nodeCount: pools.reduce((s, p) => s + (p.node_quantity ?? 0), 0),
      nodePlan: str(biggest?.plan),
      created: str(c.date_created),
    },
    {
      outputs: { apiEndpoint: str(c.endpoint), clusterId: c.id },
      ...(c.date_created ? { created: c.date_created } : {}),
    },
  );
}

export function mapNodePool(
  p: VultrNodePool,
  cluster: VultrKubernetesCluster,
  accountId: string,
): ResourceInstance {
  const nodes = p.nodes ?? [];
  return instance(
    accountId,
    "node-pool",
    `${cluster.id}/${p.id}`,
    str(p.label) || `${str(p.plan)} pool`,
    {
      label: str(p.label),
      plan: str(p.plan),
      nodeQuantity: p.node_quantity ?? 0,
      autoScaler: p.auto_scaler === true,
      minNodes: p.min_nodes ?? 0,
      maxNodes: p.max_nodes ?? 0,
      tag: str(p.tag),
      status: str(p.status),
      nodesActive: nodes.filter((n) => n.status === "active").length,
      clusterId: cluster.id,
      region: str(cluster.region),
    },
    {
      parentResourceId: `${accountId}:kubernetes-cluster:${cluster.id}`,
      ...(p.date_created ? { created: p.date_created } : {}),
    },
  );
}

export async function listClusters(api: VultrApi, accountId: string) {
  return (await api.all<VultrKubernetesCluster>("/kubernetes/clusters", "vke_clusters")).map((c) =>
    mapCluster(c, accountId),
  );
}

export async function listNodePools(api: VultrApi, accountId: string) {
  const clusters = await api.all<VultrKubernetesCluster>("/kubernetes/clusters", "vke_clusters");
  return clusters.flatMap((c) => (c.node_pools ?? []).map((p) => mapNodePool(p, c, accountId)));
}

// --- Databases -------------------------------------------------------------------

export function mapDatabase(d: VultrDatabase, accountId: string): ResourceInstance {
  const engine = str(d.database_engine);
  return instance(
    accountId,
    "database",
    d.id,
    str(d.label),
    {
      label: str(d.label),
      engine,
      version: str(d.database_engine_version),
      region: str(d.region),
      status: str(d.status),
      plan: str(d.plan),
      vcpus: d.plan_vcpus ?? 0,
      ramMb: d.plan_ram ?? 0,
      diskGb: d.plan_disk ?? 0,
      replicas: d.plan_replicas ?? 0,
      trustedIps: (d.trusted_ips ?? []).join(", "),
      maintenanceDow: str(d.maintenance_dow),
      maintenanceTime: str(d.maintenance_time),
      host: str(d.host),
      publicHost: str(d.public_host),
      port: str(d.port),
      dbName: str(d.dbname),
      latestBackup: str(d.latest_backup),
      managedBackups: engine !== "kafka",
      vpcId: str(d.vpc_id),
      tag: str(d.tag),
      created: str(d.date_created),
    },
    {
      outputs: {
        host: str(d.host),
        port: str(d.port),
        username: str(d.user),
        database: str(d.dbname),
      },
      ...(d.date_created ? { created: d.date_created } : {}),
    },
  );
}

export async function listDatabases(api: VultrApi, accountId: string) {
  return (await api.all<VultrDatabase>("/databases", "databases")).map((d) =>
    mapDatabase(d, accountId),
  );
}

export function mapDatabaseUser(
  u: VultrDatabaseUser,
  databaseId: string,
  accountId: string,
): ResourceInstance {
  return instance(
    accountId,
    "database-user",
    `${databaseId}/${u.username}`,
    u.username,
    {
      username: u.username,
      encryption: str(u.encryption),
      permission: str(u.permission),
      databaseId,
    },
    { parentResourceId: `${accountId}:database:${databaseId}` },
  );
}

export function mapLogicalDb(
  name: string,
  databaseId: string,
  accountId: string,
): ResourceInstance {
  return instance(
    accountId,
    "database-db",
    `${databaseId}/${name}`,
    name,
    { name, databaseId },
    { parentResourceId: `${accountId}:database:${databaseId}` },
  );
}

export async function listDatabaseUsers(api: VultrApi, accountId: string) {
  const dbs = await api.all<VultrDatabase>("/databases", "databases");
  const rows = await mapPooled(dbs, 6, async (d) => {
    try {
      const res = await api.get<{ users?: VultrDatabaseUser[] }>(`/databases/${d.id}/users`);
      return (res.users ?? []).map((u) => mapDatabaseUser(u, d.id, accountId));
    } catch {
      return [];
    }
  });
  return rows.flat();
}

export async function listLogicalDbs(api: VultrApi, accountId: string) {
  const dbs = (await api.all<VultrDatabase>("/databases", "databases")).filter((d) =>
    ["mysql", "pg"].includes(str(d.database_engine)),
  );
  const rows = await mapPooled(dbs, 6, async (d) => {
    try {
      const res = await api.get<{ dbs?: Array<{ name: string }> }>(`/databases/${d.id}/dbs`);
      return (res.dbs ?? []).map((x) => mapLogicalDb(x.name, d.id, accountId));
    } catch {
      return [];
    }
  });
  return rows.flat();
}

// --- Load balancers ----------------------------------------------------------------

export function healthCheckSummary(lb: VultrLoadBalancer): string {
  const h = lb.health_check;
  if (!h) return "";
  const proto = str(h.protocol || "http").toUpperCase();
  return `${proto}:${h.port ?? 80}${h.protocol === "tcp" ? "" : (h.path ?? "/")} every ${h.check_interval ?? 15}s`;
}

export function mapLoadBalancer(lb: VultrLoadBalancer, accountId: string): ResourceInstance {
  const instances = lb.instances ?? [];
  return instance(
    accountId,
    "load-balancer",
    lb.id,
    str(lb.label) || `Load balancer ${lb.id.slice(0, 8)}`,
    {
      label: str(lb.label),
      region: str(lb.region),
      status: str(lb.status),
      ipv4: str(lb.ipv4),
      ipv6: str(lb.ipv6),
      nodes: lb.nodes ?? 1,
      balancingAlgorithm: str(lb.generic_info?.balancing_algorithm || "roundrobin"),
      sslRedirect: lb.generic_info?.ssl_redirect === true,
      proxyProtocol: lb.generic_info?.proxy_protocol === true,
      instanceIds: instances.join(", "),
      instanceCount: instances.length,
      ruleCount: (lb.forwarding_rules ?? []).length,
      hasSsl: lb.has_ssl === true,
      healthCheck: healthCheckSummary(lb),
      vpcId: str(lb.generic_info?.vpc),
      created: str(lb.date_created),
    },
    {
      outputs: { ipv4: str(lb.ipv4), ipv6: str(lb.ipv6) },
      ...(lb.date_created ? { created: lb.date_created } : {}),
    },
  );
}

export async function listLoadBalancers(api: VultrApi, accountId: string) {
  return (await api.all<VultrLoadBalancer>("/load-balancers", "load_balancers")).map((lb) =>
    mapLoadBalancer(lb, accountId),
  );
}

// --- Firewalls ------------------------------------------------------------------------

const WEB_PORTS = new Set(["80", "443"]);

/** Ports a firewall group opens to the whole internet, other than 80/443. */
export function openToWorld(rules: VultrFirewallRule[]): string {
  const open = new Set<string>();
  for (const r of rules) {
    const anywhere =
      (r.subnet === "0.0.0.0" || r.subnet === "::") && (r.subnet_size ?? 0) === 0 && !r.source;
    if (!anywhere) continue;
    const proto = str(r.protocol).toLowerCase();
    if (proto === "icmp" || proto === "icmpv6") continue;
    const port = str(r.port) || "all";
    if (proto === "tcp" && WEB_PORTS.has(port)) continue;
    open.add(`${proto}/${port}`);
  }
  return [...open].sort().join(", ");
}

export function mapFirewallGroup(
  g: VultrFirewallGroup,
  accountId: string,
  rules: VultrFirewallRule[] | null,
): ResourceInstance {
  const fields: Fields = {
    description: str(g.description),
    ruleCount: g.rule_count ?? 0,
    maxRuleCount: g.max_rule_count ?? 0,
    instanceCount: g.instance_count ?? 0,
    created: str(g.date_created),
  };
  if (rules) fields["openToWorld"] = openToWorld(rules);
  return instance(
    accountId,
    "firewall-group",
    g.id,
    str(g.description) || `Firewall group ${g.id.slice(0, 8)}`,
    fields,
    { outputs: { firewallGroupId: g.id }, ...(g.date_created ? { created: g.date_created } : {}) },
  );
}

export async function listFirewallGroups(api: VultrApi, accountId: string) {
  const groups = await api.all<VultrFirewallGroup>("/firewalls", "firewall_groups");
  return mapPooled(groups, 6, async (g) => {
    let rules: VultrFirewallRule[] | null = null;
    try {
      rules = await api.all<VultrFirewallRule>(`/firewalls/${g.id}/rules`, "firewall_rules");
    } catch {
      rules = null;
    }
    return mapFirewallGroup(g, accountId, rules);
  });
}

// --- VPCs, reserved IPs ---------------------------------------------------------------

export function mapVpc(
  v: VultrVpc,
  accountId: string,
  attachments: number | null,
): ResourceInstance {
  const fields: Fields = {
    description: str(v.description),
    region: str(v.region),
    subnet: v.v4_subnet ? `${v.v4_subnet}/${v.v4_subnet_mask ?? ""}` : "",
    created: str(v.date_created),
  };
  if (attachments !== null) fields["attachmentCount"] = attachments;
  return instance(accountId, "vpc", v.id, str(v.description) || `VPC ${v.id.slice(0, 8)}`, fields, {
    outputs: { vpcId: v.id },
    ...(v.date_created ? { created: v.date_created } : {}),
  });
}

export async function listVpcs(api: VultrApi, accountId: string) {
  const vpcs = await api.all<VultrVpc>("/vpcs", "vpcs");
  return mapPooled(vpcs, 6, async (v) => {
    let count: number | null = null;
    try {
      count = (await api.all<unknown>(`/vpcs/${v.id}/attachments`, "attachments")).length;
    } catch {
      count = null;
    }
    return mapVpc(v, accountId, count);
  });
}

export function mapReservedIp(r: VultrReservedIp, accountId: string): ResourceInstance {
  const address = r.ip_type === "v6" ? `${str(r.subnet)}/${r.subnet_size ?? 64}` : str(r.subnet);
  return instance(
    accountId,
    "reserved-ip",
    r.id,
    str(r.label) || address,
    {
      label: str(r.label),
      address,
      ipType: str(r.ip_type),
      region: str(r.region),
      instanceId: str(r.instance_id),
    },
    { outputs: { ip: str(r.subnet) } },
  );
}

export async function listReservedIps(api: VultrApi, accountId: string) {
  return (await api.all<VultrReservedIp>("/reserved-ips", "reserved_ips")).map((r) =>
    mapReservedIp(r, accountId),
  );
}

// --- DNS ------------------------------------------------------------------------------

export function mapDomain(
  d: VultrDomain,
  accountId: string,
  recordCount: number | null,
): ResourceInstance {
  const fields: Fields = {
    domain: d.domain,
    dnsSec: str(d.dns_sec),
    created: str(d.date_created),
  };
  if (recordCount !== null) fields["recordCount"] = recordCount;
  return instance(accountId, "domain", d.domain, d.domain, fields, {
    outputs: { nameservers: "ns1.vultr.com, ns2.vultr.com" },
    ...(d.date_created ? { created: d.date_created } : {}),
  });
}

export function mapDnsRecord(
  r: VultrDomainRecord,
  domain: string,
  accountId: string,
): ResourceInstance {
  const name = str(r.name);
  return instance(
    accountId,
    "dns-record",
    `${domain}/${r.id}`,
    `${name || "@"} ${str(r.type)}`,
    {
      type: str(r.type),
      name,
      data: str(r.data),
      ttl: r.ttl ?? 0,
      priority: r.priority ?? 0,
      domainName: domain,
    },
    { parentResourceId: `${accountId}:domain:${domain}` },
  );
}

export async function listDomains(api: VultrApi, accountId: string) {
  const domains = await api.all<VultrDomain>("/domains", "domains");
  return mapPooled(domains, 6, async (d) => {
    let count: number | null = null;
    try {
      count = (
        await api.all<unknown>(`/domains/${encodeURIComponent(d.domain)}/records`, "records")
      ).length;
    } catch {
      count = null;
    }
    return mapDomain(d, accountId, count);
  });
}

export async function listDnsRecords(api: VultrApi, accountId: string) {
  const domains = await api.all<VultrDomain>("/domains", "domains");
  const rows = await mapPooled(domains, 6, async (d) => {
    try {
      const records = await api.all<VultrDomainRecord>(
        `/domains/${encodeURIComponent(d.domain)}/records`,
        "records",
      );
      return records.map((r) => mapDnsRecord(r, d.domain, accountId));
    } catch {
      return [];
    }
  });
  return rows.flat();
}

// --- Object storage ---------------------------------------------------------------------

export function mapObjectStorage(s: VultrObjectStorage, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "object-storage",
    s.id,
    str(s.label) || `Object Storage ${s.id.slice(0, 8)}`,
    {
      label: str(s.label),
      region: str(s.region),
      status: str(s.status),
      tier: str(s.tier?.sales_name),
      s3Hostname: str(s.s3_hostname),
      clusterId: s.cluster_id ?? 0,
      created: str(s.date_created),
    },
    {
      outputs: { s3Endpoint: s.s3_hostname ? `https://${s.s3_hostname}` : "" },
      ...(s.date_created ? { created: s.date_created } : {}),
    },
  );
}

export async function listObjectStorages(api: VultrApi, accountId: string) {
  return (await api.all<VultrObjectStorage>("/object-storage", "object_storages")).map((s) =>
    mapObjectStorage(s, accountId),
  );
}

export function mapBucket(
  name: string,
  sub: VultrObjectStorage,
  accountId: string,
  createdAt?: string,
): ResourceInstance {
  const host = str(sub.s3_hostname);
  return instance(
    accountId,
    "bucket",
    `${sub.id}/${name}`,
    name,
    {
      name,
      region: str(sub.region),
      subscriptionId: sub.id,
      s3Hostname: host,
      created: str(createdAt),
    },
    {
      outputs: { url: host ? `https://${host}/${name}` : "" },
      parentResourceId: `${accountId}:object-storage:${sub.id}`,
      ...(createdAt ? { created: createdAt } : {}),
    },
  );
}

export async function listBuckets(api: VultrApi, accountId: string) {
  const subs = (await api.all<VultrObjectStorage>("/object-storage", "object_storages")).filter(
    (s) => s.status === "active",
  );
  const rows = await mapPooled(subs, 6, async (s) => {
    try {
      const res = await api.get<{ buckets?: Array<{ name: string; date_created?: string }> }>(
        `/object-storage/${s.id}/bucket`,
      );
      return (res.buckets ?? []).map((b) => mapBucket(b.name, s, accountId, b.date_created));
    } catch {
      return [];
    }
  });
  return rows.flat();
}

// --- Account-level ----------------------------------------------------------------------

export function mapSshKey(k: VultrSshKey, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "ssh-key",
    k.id,
    str(k.name),
    { name: str(k.name), publicKey: str(k.ssh_key), created: str(k.date_created) },
    { outputs: { sshKeyId: k.id }, ...(k.date_created ? { created: k.date_created } : {}) },
  );
}

export async function listSshKeys(api: VultrApi, accountId: string) {
  return (await api.all<VultrSshKey>("/ssh-keys", "ssh_keys")).map((k) => mapSshKey(k, accountId));
}

export function mapStartupScript(s: VultrStartupScript, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "startup-script",
    s.id,
    str(s.name),
    { name: str(s.name), type: str(s.type || "boot"), updated: str(s.date_modified) },
    { outputs: { scriptId: s.id }, ...(s.date_created ? { created: s.date_created } : {}) },
  );
}

export async function listStartupScripts(api: VultrApi, accountId: string) {
  return (await api.all<VultrStartupScript>("/startup-scripts", "startup_scripts")).map((s) =>
    mapStartupScript(s, accountId),
  );
}

interface BandwidthPeriod {
  gb_out?: number;
  instance_bandwidth_credits?: number;
  free_bandwidth_credits?: number;
  purchased_bandwidth_credits?: number;
  overage_cost?: number;
}

export function mapAccount(
  a: VultrAccount,
  accountId: string,
  bw: { current_month_to_date?: BandwidthPeriod; current_month_projected?: BandwidthPeriod } | null,
): ResourceInstance {
  const fields: Fields = {
    name: str(a.name),
    email: str(a.email),
    balance: a.balance ?? 0,
    pendingCharges: a.pending_charges ?? 0,
    lastPaymentDate: str(a.last_payment_date),
    lastPaymentAmount: a.last_payment_amount ?? 0,
  };
  const mtd = bw?.current_month_to_date;
  if (mtd) {
    fields["bandwidthGbOut"] = mtd.gb_out ?? 0;
    fields["bandwidthCreditsGb"] =
      (mtd.instance_bandwidth_credits ?? 0) +
      (mtd.free_bandwidth_credits ?? 0) +
      (mtd.purchased_bandwidth_credits ?? 0);
  }
  const proj = bw?.current_month_projected;
  if (proj) fields["bandwidthProjectedOverage"] = proj.overage_cost ?? 0;
  return instance(
    accountId,
    "account",
    "account",
    str(a.name) || str(a.email) || "Vultr account",
    fields,
  );
}

export async function listAccount(api: VultrApi, accountId: string) {
  const [acct, bw] = await Promise.all([
    api.get<{ account?: VultrAccount }>("/account"),
    api
      .get<{ bandwidth?: Record<string, BandwidthPeriod> }>("/account/bandwidth")
      .catch(() => null),
  ]);
  return [mapAccount(acct.account ?? {}, accountId, bw?.bandwidth ?? null)];
}

export function mapInvoice(inv: VultrInvoice, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "invoice",
    String(inv.id),
    str(inv.description) || `Invoice ${inv.id}`,
    {
      description: str(inv.description) || `Invoice ${inv.id}`,
      date: str(inv.date),
      amount: inv.amount ?? 0,
      balance: inv.balance ?? 0,
    },
    {
      parentResourceId: `${accountId}:account:account`,
      ...(inv.date ? { created: inv.date } : {}),
    },
  );
}

export async function listInvoices(api: VultrApi, accountId: string) {
  return (await api.all<VultrInvoice>("/billing/invoices", "billing_invoices")).map((i) =>
    mapInvoice(i, accountId),
  );
}
