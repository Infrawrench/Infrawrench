/**
 * Listing: UpCloud API objects to `ResourceInstance`s. Legacy IaaS
 * collections are double-wrapped (`{ servers: { server: [...] } }`) and are
 * unwrapped with `unwrap`; managed services are bare arrays paged with
 * `limit`/`offset`.
 *
 * Fields an orphan/posture rule reads are always written.
 */

import type { ResourceInstance } from "@infrawrench/plugin-base";
import { type UpCloudApi, labelsText, mapPooled, unwrap } from "./api.js";

export const PLUGIN_ID = "upcloud";

type Fields = Record<string, string | number | boolean>;
// UpCloud objects are read loosely: many numbers arrive as strings.
export type Json = Record<string, unknown>;

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

export const str = (v: unknown) => (v == null ? "" : String(v));
export const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const yes = (v: unknown) => v === true || v === "yes" || v === "on" || v === "true";
const epochIso = (v: unknown): string => {
  if (typeof v === "number" && v > 1e8) return new Date(v * 1000).toISOString();
  return str(v);
};

// --- Servers -----------------------------------------------------------------------

export function serverAddresses(s: Json): { ipv4: string; utility: string; ipv6: string } {
  const ips = unwrap<Json>(s, "ip_addresses", "ip_address");
  const pick = (access: string, family: string) =>
    str(ips.find((i) => i["access"] === access && i["family"] === family)?.["address"]);
  return {
    ipv4: pick("public", "IPv4"),
    utility: pick("utility", "IPv4"),
    ipv6: pick("public", "IPv6"),
  };
}

export function mapServer(s: Json, accountId: string): ResourceInstance {
  const addr = serverAddresses(s);
  const storages = unwrap<Json>(s, "storage_devices", "storage_device");
  const backup = str(s["simple_backup"]);
  const plan = backup && backup !== "no" ? (backup.split(",")[1] ?? "") : "";
  const created = epochIso(s["created"]);
  return instance(
    accountId,
    "server",
    str(s["uuid"]),
    str(s["title"]) || str(s["hostname"]),
    {
      title: str(s["title"]),
      hostname: str(s["hostname"]),
      state: str(s["state"]),
      plan: str(s["plan"]),
      region: str(s["zone"]),
      cores: num(s["core_number"]),
      memoryMb: num(s["memory_amount"]),
      firewall: yes(s["firewall"]),
      simpleBackup: plan || "no",
      backupsOn: plan !== "",
      storages: storages
        .map((d) => `${str(d["storage_title"])} (${str(d["storage_size"])} GB)`)
        .join(", "),
      serverGroup: str(s["server_group"]),
      metadata: yes(s["metadata"]),
      labels: labelsText(s["labels"]),
      created,
    },
    {
      outputs: {
        ipv4: addr.ipv4,
        ipv4Private: addr.utility,
        ipv6: addr.ipv6,
        serverId: str(s["uuid"]),
      },
      ...(created ? { created } : {}),
    },
  );
}

/** The list omits addresses, so each server is read in full (eight at a time). */
export async function listServers(api: UpCloudApi, accountId: string) {
  const list = unwrap<Json>(await api.get("/server"), "servers", "server");
  return mapPooled(list, 8, async (s) => {
    try {
      const full = await api.get<{ server?: Json }>(`/server/${str(s["uuid"])}`);
      return mapServer(full.server ?? s, accountId);
    } catch {
      return mapServer(s, accountId);
    }
  });
}

// --- Storage ---------------------------------------------------------------------------

export function backupRuleText(rule: unknown): string {
  const r = rule as Json | undefined;
  if (!r || !r["interval"]) return "";
  return `${str(r["interval"])},${str(r["time"])},${str(r["retention"])}`;
}

export function mapStorage(s: Json, accountId: string): ResourceInstance {
  const servers = unwrap<string>(s, "servers", "server");
  const backups = unwrap<string>(s, "backups", "backup");
  return instance(
    accountId,
    "storage",
    str(s["uuid"]),
    str(s["title"]),
    {
      title: str(s["title"]),
      sizeGb: num(s["size"]),
      tier: str(s["tier"]),
      region: str(s["zone"]),
      state: str(s["state"]),
      serverIds: servers.join(", "),
      encrypted: yes(s["encrypted"]),
      backupRule: backupRuleText(s["backup_rule"]),
      backupCount: backups.length,
      labels: labelsText(s["labels"]),
      created: str(s["created"]),
    },
    {
      outputs: { storageId: str(s["uuid"]) },
      ...(s["created"] ? { created: str(s["created"]) } : {}),
    },
  );
}

export function mapBackup(s: Json, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "backup",
    str(s["uuid"]),
    str(s["title"]),
    {
      title: str(s["title"]),
      origin: str(s["origin"]),
      sizeGb: num(s["size"]),
      state: str(s["state"]),
      region: str(s["zone"]),
      createdAt: str(s["created"]),
    },
    s["created"] ? { created: str(s["created"]) } : {},
  );
}

export function mapTemplate(s: Json, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "template",
    str(s["uuid"]),
    str(s["title"]),
    {
      title: str(s["title"]),
      sizeGb: num(s["size"]),
      state: str(s["state"]),
      region: str(s["zone"]),
      templateType: str(s["template_type"]),
      created: str(s["created"]),
    },
    { outputs: { templateId: str(s["uuid"]) } },
  );
}

async function privateStorages(
  api: UpCloudApi,
  kind: "normal" | "backup" | "template",
): Promise<Json[]> {
  // `/storage/private` lists the account's own storages of every type.
  const all = unwrap<Json>(await api.get("/storage/private"), "storages", "storage");
  return all.filter((s) => s["type"] === kind);
}

export async function listStorages(api: UpCloudApi, accountId: string) {
  const list = await privateStorages(api, "normal");
  return mapPooled(list, 8, async (s) => {
    try {
      const full = await api.get<{ storage?: Json }>(`/storage/${str(s["uuid"])}`);
      return mapStorage(full.storage ?? s, accountId);
    } catch {
      return mapStorage(s, accountId);
    }
  });
}

export async function listBackups(api: UpCloudApi, accountId: string) {
  return (await privateStorages(api, "backup")).map((s) => mapBackup(s, accountId));
}

export async function listTemplates(api: UpCloudApi, accountId: string) {
  return (await privateStorages(api, "template")).map((s) => mapTemplate(s, accountId));
}

// --- Networking ----------------------------------------------------------------------------

export function mapNetwork(n: Json, accountId: string): ResourceInstance {
  const nets = unwrap<Json>(n, "ip_networks", "ip_network");
  const v4 = nets.find((x) => x["family"] === "IPv4") ?? nets[0];
  const servers = unwrap<Json>(n, "servers", "server");
  return instance(
    accountId,
    "network",
    str(n["uuid"]),
    str(n["name"]),
    {
      name: str(n["name"]),
      region: str(n["zone"]),
      cidr: str(v4?.["address"]),
      dhcp: yes(v4?.["dhcp"]),
      router: str(n["router"]),
      serverCount: servers.length,
      labels: labelsText(n["labels"]),
    },
    { outputs: { networkId: str(n["uuid"]) } },
  );
}

export async function listNetworks(api: UpCloudApi, accountId: string) {
  const nets = unwrap<Json>(await api.get("/network"), "networks", "network");
  return nets.filter((n) => n["type"] === "private").map((n) => mapNetwork(n, accountId));
}

export function mapRouter(r: Json, accountId: string): ResourceInstance {
  const networks = unwrap<Json>(r, "attached_networks", "network");
  const routes = (r["static_routes"] as Json[] | undefined) ?? [];
  return instance(
    accountId,
    "router",
    str(r["uuid"]),
    str(r["name"]),
    {
      name: str(r["name"]),
      networkCount: networks.length,
      staticRoutes: routes.map((x) => `${str(x["route"])} via ${str(x["nexthop"])}`).join(", "),
      labels: labelsText(r["labels"]),
    },
    { outputs: { routerId: str(r["uuid"]) } },
  );
}

export async function listRouters(api: UpCloudApi, accountId: string) {
  return unwrap<Json>(await api.get("/router"), "routers", "router").map((r) =>
    mapRouter(r, accountId),
  );
}

export function mapFloatingIp(ip: Json, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "floating-ip",
    str(ip["address"]),
    str(ip["address"]),
    {
      address: str(ip["address"]),
      family: str(ip["family"]),
      region: str(ip["zone"]),
      serverId: str(ip["server"]),
      ptrRecord: str(ip["ptr_record"]),
    },
    { outputs: { ip: str(ip["address"]) } },
  );
}

export async function listFloatingIps(api: UpCloudApi, accountId: string) {
  const ips = unwrap<Json>(await api.get("/ip_address"), "ip_addresses", "ip_address");
  return ips.filter((ip) => yes(ip["floating"])).map((ip) => mapFloatingIp(ip, accountId));
}

// --- Kubernetes ------------------------------------------------------------------------------

export function mapCluster(c: Json, accountId: string): ResourceInstance {
  const groups = (c["node_groups"] as Json[] | undefined) ?? [];
  const biggest = [...groups].sort((a, b) => num(b["count"]) - num(a["count"]))[0];
  return instance(
    accountId,
    "kubernetes-cluster",
    str(c["uuid"]),
    str(c["name"]),
    {
      name: str(c["name"]),
      region: str(c["zone"]),
      version: str(c["version"]),
      plan: str(c["plan"]),
      state: str(c["state"]),
      network: str(c["network"]),
      networkCidr: str(c["network_cidr"]),
      privateNodeGroups: c["private_node_groups"] === true,
      controlPlaneIpFilter: ((c["control_plane_ip_filter"] as string[] | undefined) ?? []).join(
        ", ",
      ),
      nodeGroupCount: groups.length,
      nodeCount: groups.reduce((s, g) => s + num(g["count"]), 0),
      nodePlan: str(biggest?.["plan"]),
      labels: labelsText(c["labels"]),
    },
    { outputs: { clusterId: str(c["uuid"]) } },
  );
}

export function mapNodeGroup(g: Json, cluster: Json, accountId: string): ResourceInstance {
  const clusterId = str(cluster["uuid"]);
  return instance(
    accountId,
    "node-group",
    `${clusterId}/${str(g["name"])}`,
    str(g["name"]),
    {
      name: str(g["name"]),
      plan: str(g["plan"]),
      count: num(g["count"]),
      state: str(g["state"]),
      antiAffinity: g["anti_affinity"] === true,
      clusterId,
      region: str(cluster["zone"]),
    },
    { parentResourceId: `${accountId}:kubernetes-cluster:${clusterId}` },
  );
}

export async function listClusters(api: UpCloudApi, accountId: string) {
  return (await api.get<Json[]>("/kubernetes")).map((c) => mapCluster(c, accountId));
}

export async function listNodeGroups(api: UpCloudApi, accountId: string) {
  const clusters = await api.get<Json[]>("/kubernetes");
  const rows = await mapPooled(clusters, 6, async (c) => {
    try {
      const groups = await api.get<Json[]>(`/kubernetes/${str(c["uuid"])}/node-groups`);
      return groups.map((g) => mapNodeGroup(g, c, accountId));
    } catch {
      return ((c["node_groups"] as Json[] | undefined) ?? []).map((g) =>
        mapNodeGroup(g, c, accountId),
      );
    }
  });
  return rows.flat();
}

// --- Databases --------------------------------------------------------------------------------

export function mapDatabase(d: Json, accountId: string): ResourceInstance {
  const props = (d["properties"] as Json | undefined) ?? {};
  const params = (d["service_uri_params"] as Json | undefined) ?? {};
  const maintenance = (d["maintenance"] as Json | undefined) ?? {};
  const backups = (d["backups"] as unknown[] | undefined) ?? [];
  const meta = (d["metadata"] as Json | undefined) ?? {};
  const version = str(
    meta["pg_version"] ||
      meta["mysql_version"] ||
      meta["valkey_version"] ||
      meta["opensearch_version"] ||
      props["version"],
  );
  return instance(
    accountId,
    "database",
    str(d["uuid"]),
    str(d["title"]) || str(d["name"]),
    {
      title: str(d["title"]),
      type: str(d["type"]),
      version,
      region: str(d["zone"]),
      state: str(d["state"]),
      powered: d["powered"] === true,
      plan: str(d["plan"]),
      nodeCount: num(d["node_count"]),
      host: str(params["host"]),
      port: str(params["port"]),
      publicAccess: props["public_access"] === true,
      ipFilter: ((props["ip_filter"] as string[] | undefined) ?? []).join(", "),
      maintenanceDow: str(maintenance["dow"]),
      maintenanceTime: str(maintenance["time"]),
      terminationProtection: d["termination_protection"] === true,
      backupCount: backups.length,
      labels: labelsText(d["labels"]),
      created: str(d["create_time"]),
    },
    {
      outputs: {
        host: str(params["host"]),
        port: str(params["port"]),
        username: str(params["user"]),
        database: str(params["dbname"]),
      },
      ...(d["create_time"] ? { created: str(d["create_time"]) } : {}),
    },
  );
}

export async function listDatabases(api: UpCloudApi, accountId: string) {
  return (await api.paged<Json>("/database")).map((d) => mapDatabase(d, accountId));
}

export function mapDatabaseUser(u: Json, databaseId: string, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "database-user",
    `${databaseId}/${str(u["username"])}`,
    str(u["username"]),
    {
      username: str(u["username"]),
      type: str(u["type"]),
      databaseId,
    },
    { parentResourceId: `${accountId}:database:${databaseId}` },
  );
}

export function mapLogicalDb(d: Json, databaseId: string, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "database-db",
    `${databaseId}/${str(d["name"])}`,
    str(d["name"]),
    {
      name: str(d["name"]),
      databaseId,
    },
    { parentResourceId: `${accountId}:database:${databaseId}` },
  );
}

export async function listDatabaseUsers(api: UpCloudApi, accountId: string) {
  const dbs = await api.paged<Json>("/database");
  const rows = await mapPooled(dbs, 6, async (d) => {
    try {
      const users = await api.get<Json[]>(`/database/${str(d["uuid"])}/users`);
      return users.map((u) => mapDatabaseUser(u, str(d["uuid"]), accountId));
    } catch {
      return [];
    }
  });
  return rows.flat();
}

export async function listLogicalDbs(api: UpCloudApi, accountId: string) {
  const dbs = (await api.paged<Json>("/database")).filter((d) =>
    ["pg", "mysql"].includes(str(d["type"])),
  );
  const rows = await mapPooled(dbs, 6, async (d) => {
    try {
      const list = await api.get<Json[]>(`/database/${str(d["uuid"])}/databases`);
      return list.map((x) => mapLogicalDb(x, str(d["uuid"]), accountId));
    } catch {
      return [];
    }
  });
  return rows.flat();
}

// --- Load balancers ------------------------------------------------------------------------------

export function mapLoadBalancer(lb: Json, accountId: string): ResourceInstance {
  const networks = (lb["networks"] as Json[] | undefined) ?? [];
  const pub = networks.find((n) => n["type"] === "public");
  const priv = networks.find((n) => n["type"] === "private");
  const backends = (lb["backends"] as Json[] | undefined) ?? [];
  const members = backends.reduce(
    (s, b) => s + ((b["members"] as unknown[] | undefined)?.length ?? 0),
    0,
  );
  const dnsName = str(pub?.["dns_name"] || lb["dns_name"]);
  return instance(
    accountId,
    "load-balancer",
    str(lb["uuid"]),
    str(lb["name"]),
    {
      name: str(lb["name"]),
      region: str(lb["zone"]),
      plan: str(lb["plan"]),
      configuredStatus: str(lb["configured_status"]),
      operationalState: str(lb["operational_state"]),
      dnsName,
      frontendCount: ((lb["frontends"] as unknown[] | undefined) ?? []).length,
      backendCount: backends.length,
      memberCount: members,
      network: str(priv?.["uuid"] || lb["network_uuid"]),
      maintenanceDow: str(lb["maintenance_dow"]),
      labels: labelsText(lb["labels"]),
    },
    {
      outputs: { hostname: dnsName },
      ...(lb["created_at"] ? { created: str(lb["created_at"]) } : {}),
    },
  );
}

export async function listLoadBalancers(api: UpCloudApi, accountId: string) {
  return (await api.paged<Json>("/load-balancer")).map((lb) => mapLoadBalancer(lb, accountId));
}

// --- Managed Object Storage ---------------------------------------------------------------------

export function publicEndpoint(s: Json): string {
  const eps = (s["endpoints"] as Json[] | undefined) ?? [];
  const pub = eps.find((e) => e["type"] === "public") ?? eps[0];
  const host = str(pub?.["domain_name"]);
  return host ? `https://${host}` : "";
}

export function mapObjectStorage(
  s: Json,
  accountId: string,
  metrics?: Json | null,
): ResourceInstance {
  const fields: Fields = {
    name: str(s["name"]),
    region: str(s["region"]),
    configuredStatus: str(s["configured_status"]),
    operationalState: str(s["operational_state"]),
    endpoint: publicEndpoint(s),
    labels: labelsText(s["labels"]),
  };
  if (metrics) {
    fields["totalObjects"] = num(metrics["total_objects"]);
    fields["totalSizeGb"] = Math.round((num(metrics["total_size_bytes"]) / 1e9) * 100) / 100;
  }
  return instance(accountId, "object-storage", str(s["uuid"]), str(s["name"]), fields, {
    outputs: { endpoint: publicEndpoint(s) },
    ...(s["created_at"] ? { created: str(s["created_at"]) } : {}),
  });
}

export async function listObjectStorages(api: UpCloudApi, accountId: string) {
  const list = await api.paged<Json>("/object-storage-2");
  return mapPooled(list, 6, async (s) => {
    const metrics = await api
      .get<Json>(`/object-storage-2/${str(s["uuid"])}/metrics`)
      .catch(() => null);
    return mapObjectStorage(s, accountId, metrics);
  });
}

export function mapBucket(b: Json, serviceId: string, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "bucket",
    `${serviceId}/${str(b["name"])}`,
    str(b["name"]),
    {
      name: str(b["name"]),
      serviceId,
      totalObjects: num(b["total_objects"]),
      totalSizeBytes: num(b["total_size_bytes"]),
    },
    { parentResourceId: `${accountId}:object-storage:${serviceId}` },
  );
}

export function mapOsUser(u: Json, serviceId: string, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "object-storage-user",
    `${serviceId}/${str(u["username"])}`,
    str(u["username"]),
    {
      username: str(u["username"]),
      policies: ((u["policies"] as Json[] | undefined) ?? []).map((p) => str(p["name"])).join(", "),
      accessKeyCount: ((u["access_keys"] as unknown[] | undefined) ?? []).length,
      serviceId,
    },
    { parentResourceId: `${accountId}:object-storage:${serviceId}` },
  );
}

export async function listBuckets(api: UpCloudApi, accountId: string) {
  const list = await api.paged<Json>("/object-storage-2");
  const rows = await mapPooled(list, 6, async (s) => {
    try {
      const buckets = await api.paged<Json>(`/object-storage-2/${str(s["uuid"])}/buckets`);
      return buckets.map((b) => mapBucket(b, str(s["uuid"]), accountId));
    } catch {
      return [];
    }
  });
  return rows.flat();
}

export async function listOsUsers(api: UpCloudApi, accountId: string) {
  const list = await api.paged<Json>("/object-storage-2");
  const rows = await mapPooled(list, 6, async (s) => {
    try {
      const users = await api.paged<Json>(`/object-storage-2/${str(s["uuid"])}/users`);
      return users.map((u) => mapOsUser(u, str(s["uuid"]), accountId));
    } catch {
      return [];
    }
  });
  return rows.flat();
}

// --- Account -----------------------------------------------------------------------------------------

export function mapAccount(a: Json, accountId: string, currency: string): ResourceInstance {
  const limits = (a["resource_limits"] as Json | undefined) ?? {};
  return instance(accountId, "account", "account", str(a["username"]) || "UpCloud account", {
    username: str(a["username"]),
    credits: Math.round(num(a["credits"])) / 100,
    currency,
    limits: Object.entries(limits)
      .map(([k, v]) => `${k}: ${str(v)}`)
      .join(", "),
  });
}

export async function accountCurrency(api: UpCloudApi, username: string): Promise<string> {
  try {
    const d = await api.get<{ account?: Json }>(`/account/details/${encodeURIComponent(username)}`);
    return str(d.account?.["currency"]) || "EUR";
  } catch {
    return "EUR";
  }
}

export async function listAccount(api: UpCloudApi, accountId: string) {
  const res = await api.get<{ account?: Json }>("/account");
  const a = res.account ?? {};
  return [mapAccount(a, accountId, await accountCurrency(api, str(a["username"])))];
}
