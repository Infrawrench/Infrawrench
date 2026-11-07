/**
 * Listing: Exoscale API v2 objects to `ResourceInstance`s. Zonal listers
 * fan out across the account's zones (four at a time) and skip a zone that
 * fails; account-wide ones (security groups, anti-affinity groups, SSH keys,
 * DNS, DBaaS) are read once from the default zone's endpoint.
 *
 * Fields an orphan/posture rule reads are written whenever they were read, and left
 * unset when they could not be, so a failed read raises no finding.
 */

import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { ApiResponse } from "@infrawrench/plugin-base";
import { rethrowIncompleteList } from "@infrawrench/plugin-base";
import type { operations } from "./api-types.gen.js";
import {
  type AnyVariant,
  DEFAULT_ZONE,
  type ExoscaleApi,
  labelsText,
  mapPooled,
  rawId,
  type Schemas,
  type Sketch,
  statusOf,
} from "./api.js";

export const PLUGIN_ID = "exoscale";

type Fields = Record<string, string | number | boolean>;
type Scalar = string | number | boolean | null | undefined;

export const str = (v: Scalar) => (v == null ? "" : String(v));
export const num = (v: Scalar) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const arr = <T>(v: readonly T[] | null | undefined): T[] => (Array.isArray(v) ? [...v] : []);
const ids = (v: readonly { id?: string }[] | undefined) =>
  arr(v)
    .map((x) => str(x["id"]))
    .filter(Boolean)
    .join(", ");

/** The DBaaS service types as one shape: what `/dbaas-{type}/{name}` answers, plus the list row. */
type ServiceDetail = ApiResponse<operations["get-dbaas-service-any"]>;
type ServiceRow = NonNullable<
  ApiResponse<operations["list-dbaas-services"]>["dbaas-services"]
>[number];
export type DbaasService = AnyVariant<ServiceDetail | ServiceRow>;

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
    .at(DEFAULT_ZONE)
    .get("/instance-type")
    .catch(() => ({ "instance-types": [] }));
  const index: TypeIndex = new Map();
  for (const t of arr(res["instance-types"])) {
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
  i: Sketch<Schemas["instance"]>,
  zone: string,
  accountId: string,
  types?: TypeIndex,
): ResourceInstance {
  const type: Schemas["instance-type"] = i["instance-type"] ?? {};
  const known = types?.get(str(type["id"]));
  const family = str(type["family"]);
  const typeName = family ? `${family}.${str(type["size"])}` : (known?.name ?? str(type["id"]));
  const template: Schemas["template"] = i["template"] ?? {};
  const manager: Schemas["manager"] = i["manager"] ?? {};
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
      labels: labelsText(i["labels"]),
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

type InstanceRow = NonNullable<ApiResponse<operations["list-instances"]>["instances"]>[number];

/** An instance from the list, and in full unless reading it failed. */
type InstanceRead = { row: InstanceRow; full?: Schemas["instance"] };

/** What `mapInstance` takes from fields only `GET /instance/{id}` answers. */
const DETAIL_ONLY_FIELDS = new Set(["diskGb", "elasticIpIds", "snapshotCount", "diskEncrypted"]);

/**
 * The list rows have no disk size, elastic IPs, snapshots or encryption, so each instance
 * is read in full (six at a time). One answering 404 went away after the list and is
 * dropped. Any other failure keeps its row, so a passing error cannot prune the instance.
 */
async function readInstances(api: ExoscaleApi, zone: string): Promise<InstanceRead[]> {
  const res = await api.at(zone).get("/instance");
  const reads = await mapPooled(
    arr(res.instances),
    6,
    async (row): Promise<InstanceRead | null> => {
      if (!row.id) return { row };
      try {
        return { row, full: await api.at(zone).get(`/instance/${rawId(row.id)}`) };
      } catch (err) {
        return statusOf(err) === 404 ? null : { row };
      }
    },
  );
  return reads.filter((r) => r !== null);
}

/**
 * A false `diskEncrypted` or an empty `elasticIpIds` from a row would be a claim nobody
 * read, so they stay unset: posture and orphan rules do not match an absent field.
 */
function mapUnreadInstance(
  row: InstanceRow,
  zone: string,
  accountId: string,
  types?: TypeIndex,
): ResourceInstance {
  const mapped = mapInstance(row, zone, accountId, types);
  const fields = Object.entries(mapped.fields).filter(([key]) => !DETAIL_ONLY_FIELDS.has(key));
  return { ...mapped, fields: Object.fromEntries(fields) };
}

export async function listInstances(api: ExoscaleApi, accountId: string, types?: TypeIndex) {
  const rows = await perZone(api, (zone) => readInstances(api, zone));
  return rows.map(({ zone, item: { row, full } }) =>
    full
      ? mapInstance({ ...row, ...full }, zone, accountId, types)
      : mapUnreadInstance(row, zone, accountId, types),
  );
}

// --- Block storage and snapshots ------------------------------------------------------

export function mapVolume(
  v: Sketch<Schemas["block-storage-volume"]>,
  zone: string,
  accountId: string,
): ResourceInstance {
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
      instanceId: str(v["instance"]?.["id"]),
      encrypted: v["encrypted"] === true,
      snapshotCount: arr(v["block-storage-snapshots"]).length,
      labels: labelsText(v["labels"]),
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
      .at(zone)
      .get("/block-storage")
      .then((r) => arr(r["block-storage-volumes"])),
  );
  return rows.map(({ zone, item }) => mapVolume(item, zone, accountId));
}

export function mapVolumeSnapshot(
  s: Sketch<Schemas["block-storage-snapshot"]>,
  zone: string,
  accountId: string,
): ResourceInstance {
  const vol = str(s["block-storage-volume"]?.["id"]);
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
      .at(zone)
      .get("/block-storage-snapshot")
      .then((r) => arr(r["block-storage-snapshots"])),
  );
  return rows.map(({ zone, item }) => mapVolumeSnapshot(item, zone, accountId));
}

export function mapSnapshot(
  s: Sketch<Schemas["snapshot"]>,
  zone: string,
  accountId: string,
): ResourceInstance {
  const inst = str(s["instance"]?.["id"]);
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
    api
      .at(zone)
      .get("/snapshot")
      .then((r) => arr(r.snapshots)),
  );
  return rows.map(({ zone, item }) => mapSnapshot(item, zone, accountId));
}

export function mapTemplate(
  t: Sketch<Schemas["template"]>,
  zone: string,
  accountId: string,
): ResourceInstance {
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
      .at(zone)
      .get("/template", { query: { visibility: "private" } })
      .then((r) => arr(r.templates)),
  );
  return rows.map(({ zone, item }) => mapTemplate(item, zone, accountId));
}

// --- Networking -------------------------------------------------------------------------

export function mapPrivateNetwork(
  n: Sketch<Schemas["private-network"]>,
  zone: string,
  accountId: string,
): ResourceInstance {
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
      labels: labelsText(n["labels"]),
    },
    { outputs: { networkId: str(n["id"]) } },
  );
}

export async function listPrivateNetworks(api: ExoscaleApi, accountId: string) {
  const rows = await perZone(api, (zone) =>
    api
      .at(zone)
      .get("/private-network")
      .then((r) => arr(r["private-networks"])),
  );
  return rows.map(({ zone, item }) => mapPrivateNetwork(item, zone, accountId));
}

const WEB = new Set(["80", "443"]);

/** Ingress ports a security group opens to the world, other than 80/443. */
export function openToWorld(rules: readonly Schemas["security-group-rule"][]): string {
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

export function mapSecurityGroup(
  g: Sketch<Schemas["security-group"]>,
  accountId: string,
): ResourceInstance {
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
      externalSources: (g["external-sources"] ?? []).join(", "),
      openToWorld: openToWorld(rules),
    },
    { outputs: { securityGroupId: str(g["id"]) } },
  );
}

export async function listSecurityGroups(api: ExoscaleApi, accountId: string) {
  const res = await api.at(DEFAULT_ZONE).get("/security-group");
  // The list carries no rules; read each group (six at a time).
  return mapPooled(arr(res["security-groups"]), 6, async (g) => {
    const full = await api
      .at(DEFAULT_ZONE)
      .get(`/security-group/${rawId(str(g["id"]))}`)
      .catch(() => g);
    return mapSecurityGroup(full, accountId);
  });
}

export function healthcheckText(h: Schemas["elastic-ip-healthcheck"] | undefined): string {
  if (!h || !h["mode"]) return "";
  return `${str(h["mode"]).toUpperCase()}:${str(h["port"])}${h["uri"] ? str(h["uri"]) : ""} every ${str(h["interval"])}s`;
}

export function mapElasticIp(
  e: Sketch<Schemas["elastic-ip"]>,
  zone: string,
  accountId: string,
  /** Unset when the holders could not all be read, which is not the same as having none. */
  attached: string[] | undefined,
): ResourceInstance {
  const hc = e["healthcheck"];
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
      ...(attached ? { instanceIds: attached.join(", ") } : {}),
      labels: labelsText(e["labels"]),
    },
    { outputs: { ip: str(e["ip"]) } },
  );
}

export async function listElasticIps(api: ExoscaleApi, accountId: string) {
  const rows = await perZone(api, async (zone) => {
    const res = await api.at(zone).get("/elastic-ip");
    const eips = arr(res["elastic-ips"]);
    if (!eips.length) return [];
    // Elastic IPs do not list their instances, and only a single instance lists its EIPs.
    const instances = await readInstances(api, zone).catch((err): null => {
      rethrowIncompleteList(err);
      return null;
    });
    const allRead = instances?.every((i) => i.full) === true;
    return eips.map((e) => {
      const holders = (instances ?? [])
        .filter((i) => arr(i.full?.["elastic-ips"]).some((x) => x["id"] === e["id"]))
        .map((i) => str(i.row.id));
      return { e, holders: holders.length || allRead ? holders : undefined };
    });
  });
  return rows.map(({ zone, item }) => mapElasticIp(item.e, zone, accountId, item.holders));
}

// --- SKS --------------------------------------------------------------------------------

export function mapCluster(
  c: Sketch<Schemas["sks-cluster"]>,
  zone: string,
  accountId: string,
): ResourceInstance {
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
      addons: (c["addons"] ?? []).join(", "),
      endpoint: str(c["endpoint"]),
      allowedNetworks: (c["allowed-networks"] ?? []).join(", "),
      nodepoolCount: pools.length,
      nodeCount: pools.reduce((s, p) => s + num(p["size"]), 0),
      labels: labelsText(c["labels"]),
      created: str(c["created-at"]),
    },
    {
      outputs: { apiEndpoint: str(c["endpoint"]), clusterId: id, clusterRef: `${zone}/${id}` },
      ...(c["created-at"] ? { created: str(c["created-at"]) } : {}),
    },
  );
}

export function mapNodepool(
  p: Sketch<Schemas["sks-nodepool"]>,
  cluster: Sketch<Schemas["sks-cluster"]>,
  zone: string,
  accountId: string,
  types?: TypeIndex,
): ResourceInstance {
  const clusterId = str(cluster["id"]);
  const typeId = str(p["instance-type"]?.["id"]);
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
      labels: labelsText(p["labels"]),
    },
    { parentResourceId: `${accountId}:sks-cluster:${zone}/${clusterId}` },
  );
}

async function clusters(api: ExoscaleApi) {
  return perZone(api, (zone) =>
    api
      .at(zone)
      .get("/sks-cluster")
      .then((r) => arr(r["sks-clusters"])),
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

export function mapNlb(
  lb: Sketch<Schemas["load-balancer"]>,
  zone: string,
  accountId: string,
): ResourceInstance {
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
      labels: labelsText(lb["labels"]),
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
      .at(zone)
      .get("/load-balancer")
      .then((r) => arr(r["load-balancers"])),
  );
  return rows.map(({ zone, item }) => mapNlb(item, zone, accountId));
}

export function mapInstancePool(
  p: Sketch<Schemas["instance-pool"]>,
  zone: string,
  accountId: string,
  types?: TypeIndex,
): ResourceInstance {
  const manager: Schemas["manager"] = p["manager"] ?? {};
  const typeId = str(p["instance-type"]?.["id"]);
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
      labels: labelsText(p["labels"]),
    },
    { outputs: { poolId: str(p["id"]) } },
  );
}

export async function listInstancePools(api: ExoscaleApi, accountId: string, types?: TypeIndex) {
  const rows = await perZone(api, (zone) =>
    api
      .at(zone)
      .get("/instance-pool")
      .then((r) => arr(r["instance-pools"])),
  );
  return rows.map(({ zone, item }) => mapInstancePool(item, zone, accountId, types));
}

// --- DBaaS ---------------------------------------------------------------------------------

/** API path segment for a DBaaS service type. */
export function dbaasPath(type: string): string {
  return type === "pg" ? "postgres" : type;
}

export function mapDbaas(s: Sketch<DbaasService>, accountId: string): ResourceInstance {
  const zone = str(s["zone"]) || DEFAULT_ZONE;
  const maintenance: Schemas["dbaas-service-maintenance"] | Record<string, never> =
    s["maintenance"] ?? {};
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
      ipFilter: (s["ip-filter"] ?? []).join(", "),
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
  const res = await api.at(DEFAULT_ZONE).get("/dbaas-service");
  return mapPooled(arr(res["dbaas-services"]), 6, async (s) => {
    const zone = str(s["zone"]) || DEFAULT_ZONE;
    const full = await api
      .at(zone)
      .get(`/dbaas-${rawId(dbaasPath(str(s["type"])))}/${rawId(str(s["name"]))}`)
      .catch(() => s);
    return mapDbaas({ ...s, ...full }, accountId);
  });
}

type ServiceOwner = { zone?: string | undefined; name?: string | undefined };
export type ServiceUser = { username?: string | undefined; type?: string | undefined };

export function mapDbaasUser(
  u: ServiceUser,
  svc: ServiceOwner,
  accountId: string,
): ResourceInstance {
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

export function mapDbaasDatabase(
  db: string,
  svc: ServiceOwner,
  accountId: string,
): ResourceInstance {
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

async function dbaasDetails(api: ExoscaleApi, types: string[]): Promise<DbaasService[]> {
  const res = await api.at(DEFAULT_ZONE).get("/dbaas-service");
  const list = arr(res["dbaas-services"]).filter((s) => types.includes(str(s["type"])));
  return mapPooled(list, 6, async (s) => {
    const zone = str(s["zone"]) || DEFAULT_ZONE;
    const full: DbaasService = await api
      .at(zone)
      .get(`/dbaas-${rawId(dbaasPath(str(s["type"])))}/${rawId(str(s["name"]))}`)
      .catch(() => ({}));
    return { ...s, ...full };
  });
}

export async function listDbaasUsers(api: ExoscaleApi, accountId: string) {
  const svcs = await dbaasDetails(api, ["pg", "mysql", "valkey", "kafka", "opensearch"]);
  return svcs.flatMap((s) =>
    arr<ServiceUser>(s["users"]).map((u) => mapDbaasUser(u, s, accountId)),
  );
}

export async function listDbaasDatabases(api: ExoscaleApi, accountId: string) {
  const svcs = await dbaasDetails(api, ["pg", "mysql"]);
  return svcs.flatMap((s) =>
    (s["databases"] ?? []).map((d) => mapDbaasDatabase(str(d), s, accountId)),
  );
}

// --- DNS ------------------------------------------------------------------------------------

export function mapDomain(
  d: Sketch<Schemas["dns-domain"]>,
  accountId: string,
  recordCount: number | null,
): ResourceInstance {
  const fields: Fields = { name: str(d["unicode-name"]), created: str(d["created-at"]) };
  if (recordCount !== null) fields["recordCount"] = recordCount;
  return instance(accountId, "dns-domain", str(d["id"]), str(d["unicode-name"]), fields);
}

export function mapRecord(
  r: Sketch<Schemas["dns-domain-record"]>,
  domain: Sketch<Schemas["dns-domain"]>,
  accountId: string,
): ResourceInstance {
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

async function domainRecords(api: ExoscaleApi, id: string) {
  const res = await api.at(DEFAULT_ZONE).get(`/dns-domain/${rawId(id)}/record`);
  return arr(res["dns-domain-records"]).filter((r) => r["system-record"] !== true);
}

export async function listDomains(api: ExoscaleApi, accountId: string) {
  const res = await api.at(DEFAULT_ZONE).get("/dns-domain");
  return mapPooled(arr(res["dns-domains"]), 6, async (d) => {
    const count = await domainRecords(api, str(d["id"]))
      .then((r) => r.length)
      .catch(() => null);
    return mapDomain(d, accountId, count);
  });
}

export async function listRecords(api: ExoscaleApi, accountId: string) {
  const res = await api.at(DEFAULT_ZONE).get("/dns-domain");
  const rows = await mapPooled(arr(res["dns-domains"]), 6, async (d) =>
    domainRecords(api, str(d["id"]))
      .then((records) => records.map((r) => mapRecord(r, d, accountId)))
      .catch(() => []),
  );
  return rows.flat();
}

// --- Object storage, keys, groups ------------------------------------------------------------

export const sosEndpoint = (zone: string) => `https://sos-${zone}.exo.io`;

export function mapBucket(
  b: Sketch<Schemas["sos-bucket-usage"]>,
  accountId: string,
): ResourceInstance {
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
  const res = await api.at(DEFAULT_ZONE).get("/sos-buckets-usage");
  return arr(res["sos-buckets-usage"]).map((b) => mapBucket(b, accountId));
}

export async function listSshKeys(api: ExoscaleApi, accountId: string) {
  const res = await api.at(DEFAULT_ZONE).get("/ssh-key");
  return arr(res["ssh-keys"]).map((k) =>
    instance(accountId, "ssh-key", str(k["name"]), str(k["name"]), {
      name: str(k["name"]),
      fingerprint: str(k["fingerprint"]),
    }),
  );
}

export async function listAntiAffinityGroups(api: ExoscaleApi, accountId: string) {
  const res = await api.at(DEFAULT_ZONE).get("/anti-affinity-group");
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

/**
 * The document and Exoscale's Go client put `balance` and `currency` at the top level.
 * The plugin has always read them under a `live-balance` key and no live call has
 * settled it, so that is still read when the top level has neither.
 */
export function liveBalance(
  answer: Schemas["live-balance"] & { "live-balance"?: Schemas["live-balance"] },
): Schemas["live-balance"] {
  const { "live-balance": wrapped, ...top } = answer;
  return top.balance !== undefined || top.currency !== undefined ? top : (wrapped ?? {});
}

export async function listOrganization(api: ExoscaleApi, accountId: string) {
  const z = api.at(DEFAULT_ZONE);
  const [org, balance] = await Promise.all([
    z.get("/organization").catch((): Schemas["organization"] => ({})),
    z.get("/live-balance").catch((): Schemas["live-balance"] => ({})),
  ]);
  const lb = liveBalance(balance);
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
