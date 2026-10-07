/**
 * Listing: Exoscale API v2 objects to `ResourceInstance`s. Zonal listers
 * fan out across the account's zones (four at a time) and skip a zone that
 * fails; account-wide ones (security groups, anti-affinity groups, SSH keys,
 * DNS, DBaaS) are read once from the default zone's endpoint.
 *
 * Fields an orphan/posture rule reads are always written.
 */

import type { ResourceInstance } from "@infrawrench/plugin-base";
import { DEFAULT_ZONE, type ExoscaleApi, labelsText, mapPooled } from "./api.js";

export const PLUGIN_ID = "exoscale";

type Fields = Record<string, string | number | boolean>;
export type Json = Record<string, unknown>;

export const str = (v: unknown) => (v == null ? "" : String(v));
export const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const ids = (v: unknown) =>
  arr(v)
    .map((x) => str(x["id"]))
    .filter(Boolean)
    .join(", ");

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

/** Run a per-zone listing across every zone, skipping zones that fail. */
export async function perZone<T>(
  api: ExoscaleApi,
  fn: (zone: string) => Promise<T[]>,
): Promise<Array<{ zone: string; item: T }>> {
  const zones = await api.zones();
  const rows = await mapPooled(zones, 4, async (zone) => {
    try {
      return (await fn(zone)).map((item) => ({ zone, item }));
    } catch {
      return [];
    }
  });
  return rows.flat();
}

/** Instance types by id, for showing `family.size` (cached per client by the caller). */
export type TypeIndex = Map<string, { name: string; cpus: number; memory: number }>;

export async function loadTypeIndex(api: ExoscaleApi): Promise<TypeIndex> {
  const res = await api
    .get<{ "instance-types"?: Json[] }>(DEFAULT_ZONE, "/instance-type")
    .catch(() => ({}) as Json);
  const index: TypeIndex = new Map();
  for (const t of arr((res as Json)["instance-types"])) {
    index.set(str(t["id"]), {
      name: `${str(t["family"])}.${str(t["size"])}`,
      cpus: num(t["cpus"]),
      memory: num(t["memory"]),
    });
  }
  return index;
}

// --- Instances -----------------------------------------------------------------------

export function mapInstance(
  i: Json,
  zone: string,
  accountId: string,
  types?: TypeIndex,
): ResourceInstance {
  const type = (i["instance-type"] as Json | undefined) ?? {};
  const known = types?.get(str(type["id"]));
  const family = str(type["family"]);
  const typeName = family ? `${family}.${str(type["size"])}` : (known?.name ?? str(type["id"]));
  const template = (i["template"] as Json | undefined) ?? {};
  const manager = (i["manager"] as Json | undefined) ?? {};
  const id = str(i["id"]);
  return instance(
    accountId,
    "instance",
    `${zone}/${id}`,
    str(i["name"]),
    {
      name: str(i["name"]),
      region: zone,
      state: str(i["state"]),
      instanceType: typeName,
      cpus: num(type["cpus"]) || (known?.cpus ?? 0),
      memoryMb: Math.round((num(type["memory"]) || (known?.memory ?? 0)) / 1048576) || 0,
      diskGb: num(i["disk-size"]),
      template: str(template["name"] || template["id"]),
      defaultUser: str(template["default-user"]),
      securityGroupIds: ids(i["security-groups"]),
      privateNetworkIds: ids(i["private-networks"]),
      elasticIpIds: ids(i["elastic-ips"]),
      managedBy: manager["type"] ? `${str(manager["type"])} ${str(manager["id"])}` : "",
      snapshotCount: arr(i["snapshots"]).length,
      diskEncrypted: i["disk-encrypted"] === true,
      labels: labelsText(i["labels"] as Record<string, string> | undefined),
      created: str(i["created-at"]),
    },
    {
      outputs: {
        ipv4: str(i["public-ip"]),
        ipv6: str(i["ipv6-address"]),
        instanceId: id,
        instanceRef: `${zone}/${id}`,
      },
      ...(i["created-at"] ? { created: str(i["created-at"]) } : {}),
    },
  );
}

export async function listInstances(api: ExoscaleApi, accountId: string, types?: TypeIndex) {
  const rows = await perZone(api, (zone) =>
    api.get<{ instances?: Json[] }>(zone, "/instance").then((r) => arr(r.instances)),
  );
  return rows.map(({ zone, item }) => mapInstance(item, zone, accountId, types));
}

// --- Block storage and snapshots ------------------------------------------------------

export function mapVolume(v: Json, zone: string, accountId: string): ResourceInstance {
  const id = str(v["id"]);
  return instance(
    accountId,
    "block-storage",
    `${zone}/${id}`,
    str(v["name"]),
    {
      name: str(v["name"]),
      region: zone,
      sizeGb: num(v["size"]),
      state: str(v["state"]),
      instanceId: str((v["instance"] as Json | undefined)?.["id"]),
      encrypted: v["encrypted"] === true,
      snapshotCount: arr(v["block-storage-snapshots"]).length,
      labels: labelsText(v["labels"] as Record<string, string> | undefined),
      created: str(v["created-at"]),
    },
    {
      outputs: { volumeId: id, volumeRef: `${zone}/${id}` },
      ...(v["created-at"] ? { created: str(v["created-at"]) } : {}),
    },
  );
}

export async function listVolumes(api: ExoscaleApi, accountId: string) {
  const rows = await perZone(api, (zone) =>
    api
      .get<{ "block-storage-volumes"?: Json[] }>(zone, "/block-storage")
      .then((r) => arr(r["block-storage-volumes"])),
  );
  return rows.map(({ zone, item }) => mapVolume(item, zone, accountId));
}

export function mapVolumeSnapshot(s: Json, zone: string, accountId: string): ResourceInstance {
  const vol = str((s["block-storage-volume"] as Json | undefined)?.["id"]);
  return instance(
    accountId,
    "block-storage-snapshot",
    `${zone}/${str(s["id"])}`,
    str(s["name"]),
    {
      name: str(s["name"]),
      region: zone,
      state: str(s["state"]),
      sizeGb: num(s["size"]),
      sourceRef: vol ? `${zone}/${vol}` : "",
      createdAt: str(s["created-at"]),
    },
    {
      outputs: { snapshotId: str(s["id"]) },
      ...(s["created-at"] ? { created: str(s["created-at"]) } : {}),
    },
  );
}

export async function listVolumeSnapshots(api: ExoscaleApi, accountId: string) {
  const rows = await perZone(api, (zone) =>
    api
      .get<{ "block-storage-snapshots"?: Json[] }>(zone, "/block-storage-snapshot")
      .then((r) => arr(r["block-storage-snapshots"])),
  );
  return rows.map(({ zone, item }) => mapVolumeSnapshot(item, zone, accountId));
}

export function mapSnapshot(s: Json, zone: string, accountId: string): ResourceInstance {
  const inst = str((s["instance"] as Json | undefined)?.["id"]);
  return instance(
    accountId,
    "snapshot",
    `${zone}/${str(s["id"])}`,
    str(s["name"]),
    {
      name: str(s["name"]),
      region: zone,
      state: str(s["state"]),
      sizeGb: num(s["size"]),
      sourceRef: inst ? `${zone}/${inst}` : "",
      createdAt: str(s["created-at"]),
    },
    s["created-at"] ? { created: str(s["created-at"]) } : {},
  );
}

export async function listSnapshots(api: ExoscaleApi, accountId: string) {
  const rows = await perZone(api, (zone) =>
    api.get<{ snapshots?: Json[] }>(zone, "/snapshot").then((r) => arr(r.snapshots)),
  );
  return rows.map(({ zone, item }) => mapSnapshot(item, zone, accountId));
}

export function mapTemplate(t: Json, zone: string, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "template",
    `${zone}/${str(t["id"])}`,
    str(t["name"]),
    {
      name: str(t["name"]),
      region: zone,
      description: str(t["description"]),
      family: str(t["family"]),
      defaultUser: str(t["default-user"]),
      sizeGb: Math.round(num(t["size"]) / 1073741824) || num(t["size"]),
      bootMode: str(t["boot-mode"]),
      created: str(t["created-at"]),
    },
    { outputs: { templateId: str(t["id"]) } },
  );
}

export async function listTemplates(api: ExoscaleApi, accountId: string) {
  const rows = await perZone(api, (zone) =>
    api
      .get<{ templates?: Json[] }>(zone, "/template?visibility=private")
      .then((r) => arr(r.templates)),
  );
  return rows.map(({ zone, item }) => mapTemplate(item, zone, accountId));
}

// --- Networking -------------------------------------------------------------------------

export function mapPrivateNetwork(n: Json, zone: string, accountId: string): ResourceInstance {
  const start = str(n["start-ip"]);
  return instance(
    accountId,
    "private-network",
    `${zone}/${str(n["id"])}`,
    str(n["name"]),
    {
      name: str(n["name"]),
      region: zone,
      description: str(n["description"]),
      managed: start !== "",
      range: start ? `${start} - ${str(n["end-ip"])} / ${str(n["netmask"])}` : "",
      leaseCount: arr(n["leases"]).length,
      labels: labelsText(n["labels"] as Record<string, string> | undefined),
    },
    { outputs: { networkId: str(n["id"]) } },
  );
}

export async function listPrivateNetworks(api: ExoscaleApi, accountId: string) {
  const rows = await perZone(api, (zone) =>
    api
      .get<{ "private-networks"?: Json[] }>(zone, "/private-network")
      .then((r) => arr(r["private-networks"])),
  );
  return rows.map(({ zone, item }) => mapPrivateNetwork(item, zone, accountId));
}

const WEB = new Set(["80", "443"]);

/** Ingress ports a security group opens to the world, other than 80/443. */
export function openToWorld(rules: Json[]): string {
  const open = new Set<string>();
  for (const r of rules) {
    if (r["flow-direction"] !== "ingress") continue;
    const net = str(r["network"]);
    if (net !== "0.0.0.0/0" && net !== "::/0") continue;
    const proto = str(r["protocol"]);
    if (proto === "icmp" || proto === "icmpv6") continue;
    const start = str(r["start-port"]);
    const end = str(r["end-port"]);
    const ports = start ? (end && end !== start ? `${start}-${end}` : start) : "all";
    if (proto === "tcp" && WEB.has(ports)) continue;
    open.add(`${proto}/${ports}`);
  }
  return [...open].sort().join(", ");
}

export function mapSecurityGroup(g: Json, accountId: string): ResourceInstance {
  const rules = arr(g["rules"]);
  return instance(
    accountId,
    "security-group",
    str(g["id"]),
    str(g["name"]),
    {
      name: str(g["name"]),
      description: str(g["description"]),
      ruleCount: rules.length,
      externalSources: ((g["external-sources"] as string[] | undefined) ?? []).join(", "),
      openToWorld: openToWorld(rules),
    },
    { outputs: { securityGroupId: str(g["id"]) } },
  );
}

export async function listSecurityGroups(api: ExoscaleApi, accountId: string) {
  const res = await api.get<{ "security-groups"?: Json[] }>(DEFAULT_ZONE, "/security-group");
  // The list carries no rules; read each group (six at a time).
  return mapPooled(arr(res["security-groups"]), 6, async (g) => {
    const full = await api
      .get<Json>(DEFAULT_ZONE, `/security-group/${str(g["id"])}`)
      .catch(() => g);
    return mapSecurityGroup(full, accountId);
  });
}

export function healthcheckText(h: Json | undefined): string {
  if (!h || !h["mode"]) return "";
  return `${str(h["mode"]).toUpperCase()}:${str(h["port"])}${h["uri"] ? str(h["uri"]) : ""} every ${str(h["interval"])}s`;
}

export function mapElasticIp(
  e: Json,
  zone: string,
  accountId: string,
  attached: string[],
): ResourceInstance {
  const hc = e["healthcheck"] as Json | undefined;
  return instance(
    accountId,
    "elastic-ip",
    `${zone}/${str(e["id"])}`,
    str(e["ip"]),
    {
      ip: str(e["ip"]),
      region: zone,
      description: str(e["description"]),
      family: str(e["addressfamily"]),
      managed: Boolean(hc?.["mode"]),
      healthcheck: healthcheckText(hc),
      instanceIds: attached.join(", "),
      labels: labelsText(e["labels"] as Record<string, string> | undefined),
    },
    { outputs: { ip: str(e["ip"]) } },
  );
}

export async function listElasticIps(api: ExoscaleApi, accountId: string) {
  const rows = await perZone(api, async (zone) => {
    const [eips, instances] = await Promise.all([
      api.get<{ "elastic-ips"?: Json[] }>(zone, "/elastic-ip").then((r) => arr(r["elastic-ips"])),
      api
        .get<{ instances?: Json[] }>(zone, "/instance")
        .then((r) => arr(r.instances))
        .catch(() => [] as Json[]),
    ]);
    // Elastic IPs do not list their instances; instances list their EIPs.
    return eips.map((e) => {
      const holders = instances
        .filter((i) => arr(i["elastic-ips"]).some((x) => x["id"] === e["id"]))
        .map((i) => str(i["id"]));
      return { e, holders };
    });
  });
  return rows.map(({ zone, item }) => mapElasticIp(item.e, zone, accountId, item.holders));
}

// --- SKS --------------------------------------------------------------------------------

export function mapCluster(c: Json, zone: string, accountId: string): ResourceInstance {
  const pools = arr(c["nodepools"]);
  const id = str(c["id"]);
  return instance(
    accountId,
    "sks-cluster",
    `${zone}/${id}`,
    str(c["name"]),
    {
      name: str(c["name"]),
      region: zone,
      description: str(c["description"]),
      version: str(c["version"]),
      level: str(c["level"]),
      state: str(c["state"]),
      cni: str(c["cni"]),
      autoUpgrade: c["auto-upgrade"] === true,
      addons: ((c["addons"] as string[] | undefined) ?? []).join(", "),
      endpoint: str(c["endpoint"]),
      allowedNetworks: ((c["allowed-networks"] as string[] | undefined) ?? []).join(", "),
      nodepoolCount: pools.length,
      nodeCount: pools.reduce((s, p) => s + num(p["size"]), 0),
      labels: labelsText(c["labels"] as Record<string, string> | undefined),
      created: str(c["created-at"]),
    },
    {
      outputs: { apiEndpoint: str(c["endpoint"]), clusterId: id, clusterRef: `${zone}/${id}` },
      ...(c["created-at"] ? { created: str(c["created-at"]) } : {}),
    },
  );
}

export function mapNodepool(
  p: Json,
  cluster: Json,
  zone: string,
  accountId: string,
  types?: TypeIndex,
): ResourceInstance {
  const clusterId = str(cluster["id"]);
  const typeId = str((p["instance-type"] as Json | undefined)?.["id"]);
  return instance(
    accountId,
    "sks-nodepool",
    `${zone}/${clusterId}/${str(p["id"])}`,
    str(p["name"]),
    {
      name: str(p["name"]),
      description: str(p["description"]),
      instanceType: types?.get(typeId)?.name ?? typeId,
      size: num(p["size"]),
      diskGb: num(p["disk-size"]),
      state: str(p["state"]),
      clusterId,
      region: zone,
      labels: labelsText(p["labels"] as Record<string, string> | undefined),
    },
    { parentResourceId: `${accountId}:sks-cluster:${zone}/${clusterId}` },
  );
}

async function clusters(api: ExoscaleApi) {
  return perZone(api, (zone) =>
    api.get<{ "sks-clusters"?: Json[] }>(zone, "/sks-cluster").then((r) => arr(r["sks-clusters"])),
  );
}

export async function listClusters(api: ExoscaleApi, accountId: string) {
  return (await clusters(api)).map(({ zone, item }) => mapCluster(item, zone, accountId));
}

export async function listNodepools(api: ExoscaleApi, accountId: string, types?: TypeIndex) {
  return (await clusters(api)).flatMap(({ zone, item }) =>
    arr(item["nodepools"]).map((p) => mapNodepool(p, item, zone, accountId, types)),
  );
}

// --- NLB and instance pools ---------------------------------------------------------------

export function mapNlb(lb: Json, zone: string, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "nlb",
    `${zone}/${str(lb["id"])}`,
    str(lb["name"]),
    {
      name: str(lb["name"]),
      region: zone,
      description: str(lb["description"]),
      ip: str(lb["ip"]),
      state: str(lb["state"]),
      serviceCount: arr(lb["services"]).length,
      labels: labelsText(lb["labels"] as Record<string, string> | undefined),
      created: str(lb["created-at"]),
    },
    {
      outputs: { ipv4: str(lb["ip"]) },
      ...(lb["created-at"] ? { created: str(lb["created-at"]) } : {}),
    },
  );
}

export async function listNlbs(api: ExoscaleApi, accountId: string) {
  const rows = await perZone(api, (zone) =>
    api
      .get<{ "load-balancers"?: Json[] }>(zone, "/load-balancer")
      .then((r) => arr(r["load-balancers"])),
  );
  return rows.map(({ zone, item }) => mapNlb(item, zone, accountId));
}

export function mapInstancePool(
  p: Json,
  zone: string,
  accountId: string,
  types?: TypeIndex,
): ResourceInstance {
  const manager = (p["manager"] as Json | undefined) ?? {};
  const typeId = str((p["instance-type"] as Json | undefined)?.["id"]);
  return instance(
    accountId,
    "instance-pool",
    `${zone}/${str(p["id"])}`,
    str(p["name"]),
    {
      name: str(p["name"]),
      region: zone,
      description: str(p["description"]),
      size: num(p["size"]),
      instanceType: types?.get(typeId)?.name ?? typeId,
      state: str(p["state"]),
      managedBy: manager["type"] ? str(manager["type"]) : "",
      labels: labelsText(p["labels"] as Record<string, string> | undefined),
    },
    { outputs: { poolId: str(p["id"]) } },
  );
}

export async function listInstancePools(api: ExoscaleApi, accountId: string, types?: TypeIndex) {
  const rows = await perZone(api, (zone) =>
    api
      .get<{ "instance-pools"?: Json[] }>(zone, "/instance-pool")
      .then((r) => arr(r["instance-pools"])),
  );
  return rows.map(({ zone, item }) => mapInstancePool(item, zone, accountId, types));
}

// --- DBaaS ---------------------------------------------------------------------------------

/** API path segment for a DBaaS service type. */
export function dbaasPath(type: string): string {
  return type === "pg" ? "postgres" : type;
}

export function mapDbaas(s: Json, accountId: string): ResourceInstance {
  const zone = str(s["zone"]) || DEFAULT_ZONE;
  const maintenance = (s["maintenance"] as Json | undefined) ?? {};
  return instance(
    accountId,
    "dbaas",
    `${zone}/${str(s["name"])}`,
    str(s["name"]),
    {
      name: str(s["name"]),
      type: str(s["type"]),
      region: zone,
      plan: str(s["plan"]),
      state: str(s["state"]),
      version: str(s["version"]),
      nodeCount: num(s["node-count"]),
      nodeCpus: num(s["node-cpu-count"]),
      nodeMemoryMb: Math.round(num(s["node-memory"]) / 1048576),
      diskGb: Math.round(num(s["disk-size"]) / 1073741824),
      ipFilter: ((s["ip-filter"] as string[] | undefined) ?? []).join(", "),
      terminationProtection: s["termination-protection"] === true,
      maintenanceDow: str(maintenance["dow"]),
      maintenanceTime: str(maintenance["time"]),
      backupCount: arr(s["backups"]).length,
      created: str(s["created-at"]),
    },
    s["created-at"] ? { created: str(s["created-at"]) } : {},
  );
}

/** The list has no IP filter, maintenance or backups, so each service is read in full. */
export async function listDbaas(api: ExoscaleApi, accountId: string) {
  const res = await api.get<{ "dbaas-services"?: Json[] }>(DEFAULT_ZONE, "/dbaas-service");
  return mapPooled(arr(res["dbaas-services"]), 6, async (s) => {
    const zone = str(s["zone"]) || DEFAULT_ZONE;
    const full = await api
      .get<Json>(zone, `/dbaas-${dbaasPath(str(s["type"]))}/${str(s["name"])}`)
      .catch(() => s);
    return mapDbaas({ ...s, ...full }, accountId);
  });
}

export function mapDbaasUser(u: Json, svc: Json, accountId: string): ResourceInstance {
  const zone = str(svc["zone"]) || DEFAULT_ZONE;
  const name = str(svc["name"]);
  return instance(
    accountId,
    "dbaas-user",
    `${zone}/${name}/${str(u["username"])}`,
    str(u["username"]),
    {
      username: str(u["username"]),
      type: str(u["type"]),
      service: name,
    },
    { parentResourceId: `${accountId}:dbaas:${zone}/${name}` },
  );
}

export function mapDbaasDatabase(db: string, svc: Json, accountId: string): ResourceInstance {
  const zone = str(svc["zone"]) || DEFAULT_ZONE;
  const name = str(svc["name"]);
  return instance(
    accountId,
    "dbaas-database",
    `${zone}/${name}/${db}`,
    db,
    { name: db, service: name },
    {
      parentResourceId: `${accountId}:dbaas:${zone}/${name}`,
    },
  );
}

async function dbaasDetails(api: ExoscaleApi, types: string[]): Promise<Json[]> {
  const res = await api.get<{ "dbaas-services"?: Json[] }>(DEFAULT_ZONE, "/dbaas-service");
  const list = arr(res["dbaas-services"]).filter((s) => types.includes(str(s["type"])));
  return mapPooled(list, 6, async (s) => {
    const zone = str(s["zone"]) || DEFAULT_ZONE;
    const full = await api
      .get<Json>(zone, `/dbaas-${dbaasPath(str(s["type"]))}/${str(s["name"])}`)
      .catch(() => ({}) as Json);
    return { ...s, ...full };
  });
}

export async function listDbaasUsers(api: ExoscaleApi, accountId: string) {
  const svcs = await dbaasDetails(api, ["pg", "mysql", "valkey", "kafka", "opensearch"]);
  return svcs.flatMap((s) => arr(s["users"]).map((u) => mapDbaasUser(u, s, accountId)));
}

export async function listDbaasDatabases(api: ExoscaleApi, accountId: string) {
  const svcs = await dbaasDetails(api, ["pg", "mysql"]);
  return svcs.flatMap((s) =>
    ((s["databases"] as string[] | undefined) ?? []).map((d) =>
      mapDbaasDatabase(str(d), s, accountId),
    ),
  );
}

// --- DNS ------------------------------------------------------------------------------------

export function mapDomain(
  d: Json,
  accountId: string,
  recordCount: number | null,
): ResourceInstance {
  const fields: Fields = { name: str(d["unicode-name"]), created: str(d["created-at"]) };
  if (recordCount !== null) fields["recordCount"] = recordCount;
  return instance(accountId, "dns-domain", str(d["id"]), str(d["unicode-name"]), fields);
}

export function mapRecord(r: Json, domain: Json, accountId: string): ResourceInstance {
  const domainId = str(domain["id"]);
  return instance(
    accountId,
    "dns-record",
    `${domainId}/${str(r["id"])}`,
    `${str(r["name"]) || "@"} ${str(r["type"])}`,
    {
      type: str(r["type"]),
      name: str(r["name"]),
      content: str(r["content"]),
      ttl: num(r["ttl"]),
      priority: num(r["priority"]),
      domainName: str(domain["unicode-name"]),
    },
    { parentResourceId: `${accountId}:dns-domain:${domainId}` },
  );
}

async function domainRecords(api: ExoscaleApi, id: string): Promise<Json[]> {
  const res = await api.get<{ "dns-domain-records"?: Json[] }>(
    DEFAULT_ZONE,
    `/dns-domain/${id}/record`,
  );
  return arr(res["dns-domain-records"]).filter((r) => r["system-record"] !== true);
}

export async function listDomains(api: ExoscaleApi, accountId: string) {
  const res = await api.get<{ "dns-domains"?: Json[] }>(DEFAULT_ZONE, "/dns-domain");
  return mapPooled(arr(res["dns-domains"]), 6, async (d) => {
    const count = await domainRecords(api, str(d["id"]))
      .then((r) => r.length)
      .catch(() => null);
    return mapDomain(d, accountId, count);
  });
}

export async function listRecords(api: ExoscaleApi, accountId: string) {
  const res = await api.get<{ "dns-domains"?: Json[] }>(DEFAULT_ZONE, "/dns-domain");
  const rows = await mapPooled(arr(res["dns-domains"]), 6, async (d) =>
    domainRecords(api, str(d["id"]))
      .then((records) => records.map((r) => mapRecord(r, d, accountId)))
      .catch(() => []),
  );
  return rows.flat();
}

// --- Object storage, keys, groups ------------------------------------------------------------

export const sosEndpoint = (zone: string) => `https://sos-${zone}.exo.io`;

export function mapBucket(b: Json, accountId: string): ResourceInstance {
  const zone = str(b["zone-name"]) || DEFAULT_ZONE;
  const name = str(b["name"]);
  return instance(
    accountId,
    "bucket",
    `${zone}/${name}`,
    name,
    {
      name,
      region: zone,
      sizeGb: Math.round((num(b["size"]) / 1e9) * 100) / 100,
      endpoint: sosEndpoint(zone),
      created: str(b["created-at"]),
    },
    {
      outputs: { url: `${sosEndpoint(zone)}/${name}`, endpoint: sosEndpoint(zone) },
      ...(b["created-at"] ? { created: str(b["created-at"]) } : {}),
    },
  );
}

export async function listBuckets(api: ExoscaleApi, accountId: string) {
  const res = await api.get<{ "sos-buckets-usage"?: Json[] }>(DEFAULT_ZONE, "/sos-buckets-usage");
  return arr(res["sos-buckets-usage"]).map((b) => mapBucket(b, accountId));
}

export async function listSshKeys(api: ExoscaleApi, accountId: string) {
  const res = await api.get<{ "ssh-keys"?: Json[] }>(DEFAULT_ZONE, "/ssh-key");
  return arr(res["ssh-keys"]).map((k) =>
    instance(accountId, "ssh-key", str(k["name"]), str(k["name"]), {
      name: str(k["name"]),
      fingerprint: str(k["fingerprint"]),
    }),
  );
}

export async function listAntiAffinityGroups(api: ExoscaleApi, accountId: string) {
  const res = await api.get<{ "anti-affinity-groups"?: Json[] }>(
    DEFAULT_ZONE,
    "/anti-affinity-group",
  );
  return arr(res["anti-affinity-groups"]).map((g) =>
    instance(
      accountId,
      "anti-affinity-group",
      str(g["id"]),
      str(g["name"]),
      {
        name: str(g["name"]),
        description: str(g["description"]),
        instanceCount: arr(g["instances"]).length,
      },
      { outputs: { groupId: str(g["id"]) } },
    ),
  );
}

export async function listOrganization(api: ExoscaleApi, accountId: string) {
  const [org, balance] = await Promise.all([
    api.get<Json>(DEFAULT_ZONE, "/organization").catch(() => ({}) as Json),
    api
      .get<{ "live-balance"?: Json }>(DEFAULT_ZONE, "/live-balance")
      .catch(() => ({}) as { "live-balance"?: Json }),
  ]);
  const lb = balance["live-balance"] ?? {};
  const fields: Fields = {
    name: str(org["name"]),
    currency: str(lb["currency"] || org["currency"]),
  };
  if (lb["balance"] !== undefined) fields["balance"] = num(lb["balance"]);
  return [
    instance(
      accountId,
      "organization",
      "organization",
      str(org["name"]) || "Exoscale organization",
      fields,
    ),
  ];
}
