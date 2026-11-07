/**
 * Listing: Linode API objects to `ResourceInstance`s.
 *
 * Every lister writes the fields its type's `orphanRule` / `postureChecks`
 * read unconditionally (an empty string, never absent), so a rule written as
 * `equals ""` means what it says. The one exception is a count derived from a
 * follow-up request: when that request fails the field is left absent, and
 * `equals` never matches an absent field, so a flaky call cannot flag a
 * healthy resource.
 */

import { pathEncode, rethrowIncompleteList, type ResourceInstance } from "@infrawrench/plugin-base";
import { segment, statusOf, xFilter, type LinodeApi } from "./api.js";
import type {
  LinodeAccount,
  LinodeBucket,
  LinodeDatabase,
  LinodeDomain,
  LinodeDomainRecord,
  LinodeFirewall,
  LinodeImage,
  LinodeInstance,
  LinodeInvoice,
  LinodeLkeCluster,
  LinodeLkePool,
  LinodeNodeBalancer,
  LinodeNodeBalancerConfig,
  LinodeReservedIp,
  LinodeStackScript,
  LinodeTransfer,
  LinodeVolume,
  LinodeVpc,
} from "./types.js";

export const PLUGIN_ID = "linode";

type Fields = Record<string, string | number | boolean>;

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Fields,
  opts: {
    outputs?: Record<string, string>;
    parentResourceId?: string;
    created?: string;
    updated?: string;
  } = {},
): ResourceInstance {
  const now = new Date().toISOString();
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
    createdAt: opts.created ?? now,
    updatedAt: opts.updated ?? opts.created ?? now,
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

const tags = (t: readonly string[] | undefined) => (t ?? []).join(", ");
const str = (v: unknown) => (v == null ? "" : String(v));

/** RFC 1918 / CGNAT private IPv4 test, for splitting a Linode's address list. */
export function isPrivateIpv4(ip: string): boolean {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
}

/** Firewall id lists per attached entity, from one `/networking/firewalls` read. */
export function firewallIndex(firewalls: LinodeFirewall[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const fw of firewalls) {
    for (const e of fw.entities ?? []) {
      if (e.id == null || !e.type) continue;
      const key = `${e.type}:${e.id}`;
      const list = index.get(key) ?? [];
      list.push(String(fw.id));
      index.set(key, list);
    }
  }
  return index;
}

async function firewallsOrEmpty(api: LinodeApi): Promise<LinodeFirewall[] | null> {
  try {
    return await api.getAll("/networking/firewalls", "data");
  } catch (err) {
    rethrowIncompleteList(err);
    return null;
  }
}

/** A parent that has gone since the list has no children. Any other failure says nothing. */
function noneIfGone(err: unknown): never[] {
  if (statusOf(err) === 404) return [];
  throw err;
}

// --- Linodes ---------------------------------------------------------------

export function mapLinode(
  l: LinodeInstance,
  accountId: string,
  fwIds?: string[] | null,
): ResourceInstance {
  const ips = l.ipv4 ?? [];
  const publicIp = ips.find((ip) => !isPrivateIpv4(ip)) ?? "";
  const privateIp = ips.find((ip) => isPrivateIpv4(ip)) ?? "";
  const fields: Fields = {
    label: str(l.label),
    status: str(l.status),
    type: str(l.type),
    region: str(l.region),
    image: str(l.image),
    vcpus: l.specs?.vcpus ?? 0,
    memoryMb: l.specs?.memory ?? 0,
    diskGb: Math.round((l.specs?.disk ?? 0) / 1024),
    backupsEnabled: l.backups?.enabled === true,
    lastBackup: str(l.backups?.last_successful),
    lkeClusterId: l.lke_cluster_id != null ? String(l.lke_cluster_id) : "",
    placementGroup: str(l.placement_group?.label),
    watchdogEnabled: l.watchdog_enabled !== false,
    tags: tags(l.tags),
    created: str(l.created),
  };
  // Only written when the firewall read succeeded: the posture check on
  // `equals ""` must not fire because a listing call failed.
  if (fwIds !== null) fields["firewallIds"] = (fwIds ?? []).join(", ");
  return instance(accountId, "linode", String(l.id), str(l.label), fields, {
    outputs: {
      ipv4: publicIp,
      ipv4Private: privateIp,
      ipv6: str(l.ipv6).replace(/\/\d+$/, ""),
      linodeId: String(l.id),
    },
    ...(l.created ? { created: l.created } : {}),
    ...(l.updated ? { updated: l.updated } : {}),
  });
}

export async function listLinodes(api: LinodeApi, accountId: string): Promise<ResourceInstance[]> {
  const [linodes, firewalls] = await Promise.all([
    api.getAll("/linode/instances", "data"),
    firewallsOrEmpty(api),
  ]);
  const index = firewalls ? firewallIndex(firewalls) : null;
  return linodes.map((l) =>
    mapLinode(l, accountId, index ? (index.get(`linode:${l.id}`) ?? []) : null),
  );
}

// --- Volumes ---------------------------------------------------------------

export function mapVolume(v: LinodeVolume, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "volume",
    String(v.id),
    str(v.label),
    {
      label: str(v.label),
      sizeGb: v.size ?? 0,
      region: str(v.region),
      status: str(v.status),
      linodeId: v.linode_id != null ? String(v.linode_id) : "",
      linodeLabel: str(v.linode_label),
      filesystemPath: str(v.filesystem_path),
      hardwareType: str(v.hardware_type),
      encryption: str(v.encryption),
      tags: tags(v.tags),
    },
    {
      outputs: { filesystemPath: str(v.filesystem_path) },
      ...(v.created ? { created: v.created } : {}),
    },
  );
}
export async function listVolumes(api: LinodeApi, accountId: string): Promise<ResourceInstance[]> {
  const volumes = await api.getAll("/volumes", "data");
  return volumes.map((v) => mapVolume(v, accountId));
}

// --- NodeBalancers -----------------------------------------------------------

export function mapNodeBalancer(
  nb: LinodeNodeBalancer,
  accountId: string,
  configs: LinodeNodeBalancerConfig[] | null,
  fwIds: string[] | null,
): ResourceInstance {
  const fields: Fields = {
    label: str(nb.label),
    region: str(nb.region),
    nbType: str(nb.type || "common"),
    hostname: str(nb.hostname),
    ipv4: str(nb.ipv4),
    ipv6: str(nb.ipv6),
    clientConnThrottle: nb.client_conn_throttle ?? 0,
    transferMb: Math.round(nb.transfer?.total ?? 0),
    lkeClusterId: nb.lke_cluster?.id != null ? String(nb.lke_cluster.id) : "",
    tags: tags(nb.tags),
  };
  if (configs) {
    const up = configs.reduce((s, c) => s + (c.nodes_status?.up ?? 0), 0);
    const down = configs.reduce((s, c) => s + (c.nodes_status?.down ?? 0), 0);
    fields["configCount"] = configs.length;
    fields["nodesUp"] = up;
    fields["nodesDown"] = down;
    fields["nodeCount"] = up + down;
  }
  if (fwIds) fields["firewallIds"] = fwIds.join(", ");
  return instance(accountId, "nodebalancer", String(nb.id), str(nb.label), fields, {
    outputs: { ipv4: str(nb.ipv4), ipv6: str(nb.ipv6), hostname: str(nb.hostname) },
    ...(nb.created ? { created: nb.created } : {}),
  });
}

export async function listNodeBalancers(
  api: LinodeApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const [nbs, firewalls] = await Promise.all([
    api.getAll("/nodebalancers", "data"),
    firewallsOrEmpty(api),
  ]);
  const index = firewalls ? firewallIndex(firewalls) : null;
  return mapPooled(nbs, 8, async (nb) => {
    let configs: LinodeNodeBalancerConfig[] | null = null;
    try {
      configs = await api.getAll(`/nodebalancers/${segment(nb.id)}/configs`, "data");
    } catch (err) {
      rethrowIncompleteList(err);
      configs = null;
    }
    return mapNodeBalancer(
      nb,
      accountId,
      configs,
      index ? (index.get(`nodebalancer:${nb.id}`) ?? []) : null,
    );
  });
}

// --- LKE ---------------------------------------------------------------------

export function mapLkeCluster(
  c: LinodeLkeCluster,
  accountId: string,
  pools: LinodeLkePool[] | null,
): ResourceInstance {
  const fields: Fields = {
    label: str(c.label),
    region: str(c.region),
    k8sVersion: str(c.k8s_version),
    tier: str(c.tier || "standard"),
    highAvailability: c.control_plane?.high_availability === true,
    tags: tags(c.tags),
    created: str(c.created),
  };
  if (pools) {
    fields["poolCount"] = pools.length;
    fields["nodeCount"] = pools.reduce((s, p) => s + (p.count ?? 0), 0);
    // The largest pool's plan stands in for "the" node plan (carbon, display).
    const biggest = [...pools].sort((a, b) => (b.count ?? 0) - (a.count ?? 0))[0];
    fields["nodeType"] = str(biggest?.type);
  }
  return instance(accountId, "lke-cluster", String(c.id), str(c.label), fields, {
    ...(c.created ? { created: c.created } : {}),
  });
}

export function mapLkePool(
  p: LinodeLkePool,
  cluster: LinodeLkeCluster,
  accountId: string,
): ResourceInstance {
  const ready = (p.nodes ?? []).filter((n) => n.status === "ready").length;
  return instance(
    accountId,
    "lke-node-pool",
    `${cluster.id}/${p.id}`,
    p.label ? `${p.label}` : `${str(p.type)} pool ${p.id}`,
    {
      label: str(p.label),
      type: str(p.type),
      count: p.count ?? 0,
      autoscalerEnabled: p.autoscaler?.enabled === true,
      autoscalerMin: p.autoscaler?.min ?? 0,
      autoscalerMax: p.autoscaler?.max ?? 0,
      nodesReady: ready,
      clusterId: String(cluster.id),
      region: str(cluster.region),
      tags: tags(p.tags),
    },
    { parentResourceId: `${accountId}:lke-cluster:${cluster.id}` },
  );
}

function poolsOf(api: LinodeApi, cluster: LinodeLkeCluster): Promise<LinodeLkePool[]> {
  return api.getAll(`/lke/clusters/${segment(cluster.id)}/pools`, "data");
}

export async function listLkeClusters(
  api: LinodeApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const clusters = await api.getAll("/lke/clusters", "data");
  return mapPooled(clusters, 8, async (cluster) => {
    let pools: LinodeLkePool[] | null = null;
    try {
      pools = await poolsOf(api, cluster);
    } catch (err) {
      rethrowIncompleteList(err);
    }
    return mapLkeCluster(cluster, accountId, pools);
  });
}

/** Pools are rows of their own, so a failed read has to throw: none would prune them. */
export async function listLkePools(api: LinodeApi, accountId: string): Promise<ResourceInstance[]> {
  const clusters = await api.getAll("/lke/clusters", "data");
  const rows = await mapPooled(clusters, 8, async (cluster) =>
    (await poolsOf(api, cluster).catch(noneIfGone)).map((p) => mapLkePool(p, cluster, accountId)),
  );
  return rows.flat();
}

// --- Object Storage ----------------------------------------------------------

interface BucketAccess {
  acl?: string;
  cors_enabled?: boolean | null;
}

export function bucketRegion(b: LinodeBucket): string {
  return str(b.region || b.cluster?.replace(/-\d+$/, ""));
}

export function mapBucket(
  b: LinodeBucket,
  accountId: string,
  access: BucketAccess | null,
): ResourceInstance {
  const region = bucketRegion(b);
  const fields: Fields = {
    name: b.label,
    region,
    hostname: str(b.hostname),
    s3Endpoint: str(b.s3_endpoint),
    endpointType: str(b.endpoint_type),
    objects: b.objects ?? 0,
    sizeBytes: b.size ?? 0,
    created: str(b.created),
  };
  if (access) {
    fields["acl"] = str(access.acl);
    fields["corsEnabled"] = access.cors_enabled === true;
  }
  return instance(accountId, "bucket", `${region}/${b.label}`, b.label, fields, {
    outputs: { hostname: str(b.hostname), s3Endpoint: str(b.s3_endpoint) },
    ...(b.created ? { created: b.created } : {}),
  });
}

export async function listBuckets(api: LinodeApi, accountId: string): Promise<ResourceInstance[]> {
  const buckets = await api.getAll("/object-storage/buckets", "data");
  return mapPooled(buckets, 8, async (b) => {
    let access: BucketAccess | null = null;
    try {
      access = await api.get(
        `/object-storage/buckets/${segment(bucketRegion(b))}/${pathEncode(b.label)}/access`,
      );
    } catch {
      access = null;
    }
    return mapBucket(b, accountId, access);
  });
}

// --- Managed Databases ---------------------------------------------------------

export function mapDatabase(d: LinodeDatabase, accountId: string): ResourceInstance {
  const engine = str(d.engine);
  return instance(
    accountId,
    "database",
    `${engine}/${d.id}`,
    str(d.label),
    {
      label: str(d.label),
      engine,
      version: str(d.version),
      region: str(d.region),
      status: str(d.status),
      type: str(d.type),
      clusterSize: d.cluster_size ?? 1,
      allowList: (d.allow_list ?? []).join(", "),
      primaryHost: str(d.hosts?.primary),
      secondaryHost: str(d.hosts?.secondary),
      port: d.port ?? 0,
      diskUsedGb: d.used_disk_size_gb ?? 0,
      diskTotalGb: d.total_disk_size_gb ?? 0,
      platform: str(d.platform),
      // Every Managed Database takes automatic daily backups; there is no
      // switch to turn them off.
      managedBackups: true,
      created: str(d.created),
    },
    {
      outputs: { host: str(d.hosts?.primary), port: d.port ? String(d.port) : "" },
      ...(d.created ? { created: d.created } : {}),
    },
  );
}

export async function listDatabases(
  api: LinodeApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const dbs = await api.getAll("/databases/instances", "data");
  return dbs.map((d) => mapDatabase(d, accountId));
}

// --- Firewalls -------------------------------------------------------------------

export function mapFirewall(fw: LinodeFirewall, accountId: string): ResourceInstance {
  const entities = fw.entities ?? [];
  return instance(
    accountId,
    "firewall",
    String(fw.id),
    str(fw.label),
    {
      label: str(fw.label),
      status: str(fw.status),
      inboundPolicy: str(fw.rules?.inbound_policy),
      outboundPolicy: str(fw.rules?.outbound_policy),
      inboundRuleCount: fw.rules?.inbound?.length ?? 0,
      outboundRuleCount: fw.rules?.outbound?.length ?? 0,
      deviceCount: entities.length,
      devices: entities.map((e) => `${e.label ?? e.id} (${e.type})`).join(", "),
      tags: tags(fw.tags),
    },
    { outputs: { firewallId: String(fw.id) }, ...(fw.created ? { created: fw.created } : {}) },
  );
}

export async function listFirewalls(
  api: LinodeApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const fws = await api.getAll("/networking/firewalls", "data");
  return fws.filter((fw) => fw.status !== "deleted").map((fw) => mapFirewall(fw, accountId));
}

// --- VPCs ------------------------------------------------------------------------

export function mapVpc(v: LinodeVpc, accountId: string): ResourceInstance {
  const subnets = v.subnets ?? [];
  return instance(
    accountId,
    "vpc",
    String(v.id),
    str(v.label),
    {
      label: str(v.label),
      region: str(v.region),
      description: str(v.description),
      subnetCount: subnets.length,
      subnets: subnets.map((s) => `${s.label ?? s.id} ${s.ipv4 ?? ""}`.trim()).join(", "),
      linodeCount: subnets.reduce((s, sub) => s + (sub.linodes?.length ?? 0), 0),
      created: str(v.created),
    },
    { outputs: { vpcId: String(v.id) }, ...(v.created ? { created: v.created } : {}) },
  );
}

export async function listVpcs(api: LinodeApi, accountId: string): Promise<ResourceInstance[]> {
  const vpcs = await api.getAll("/vpcs", "data");
  return vpcs.map((v) => mapVpc(v, accountId));
}

// --- Reserved IPs ------------------------------------------------------------------

export function mapReservedIp(ip: LinodeReservedIp, accountId: string): ResourceInstance {
  const entity = ip.assigned_entity;
  const entityId =
    entity?.id != null ? String(entity.id) : ip.linode_id != null ? String(ip.linode_id) : "";
  return instance(
    accountId,
    "reserved-ip",
    ip.address,
    ip.address,
    {
      address: ip.address,
      region: str(ip.region),
      assignedEntityId: entityId,
      assignedEntityType: str(entity?.type ?? (ip.linode_id != null ? "linode" : "")),
      assignedEntityLabel: str(entity?.label),
      rdns: str(ip.rdns),
      tags: tags(ip.tags),
    },
    { outputs: { ip: ip.address } },
  );
}

export async function listReservedIps(
  api: LinodeApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const ips = await api.getAll("/networking/reserved/ips", "data");
  return ips.map((ip) => mapReservedIp(ip, accountId));
}

// --- Domains ---------------------------------------------------------------------

export function mapDomain(
  d: LinodeDomain,
  accountId: string,
  recordCount?: number,
): ResourceInstance {
  const fields: Fields = {
    domain: str(d.domain),
    type: str(d.type),
    status: str(d.status),
    soaEmail: str(d.soa_email),
    ttlSec: d.ttl_sec ?? 0,
    masterIps: (d.master_ips ?? []).join(", "),
    description: str(d.description),
    tags: tags(d.tags),
  };
  if (recordCount != null) fields["recordCount"] = recordCount;
  return instance(accountId, "domain", String(d.id), str(d.domain), fields, {
    outputs: {
      nameservers: "ns1.linode.com, ns2.linode.com, ns3.linode.com, ns4.linode.com, ns5.linode.com",
    },
  });
}

export function mapDomainRecord(
  r: LinodeDomainRecord,
  domain: LinodeDomain,
  accountId: string,
): ResourceInstance {
  const name = r.name ? r.name : "@";
  return instance(
    accountId,
    "domain-record",
    `${domain.id}/${r.id}`,
    `${r.type ?? ""} ${name}`.trim(),
    {
      type: str(r.type),
      name,
      target: str(r.target),
      ttlSec: r.ttl_sec ?? 0,
      priority: r.priority ?? 0,
      weight: r.weight ?? 0,
      port: r.port ?? 0,
      service: str(r.service),
      protocol: str(r.protocol),
      tag: str(r.tag),
      domainName: str(domain.domain),
    },
    { parentResourceId: `${accountId}:domain:${domain.id}` },
  );
}

function recordsOf(api: LinodeApi, domain: LinodeDomain): Promise<LinodeDomainRecord[]> {
  return api.getAll(`/domains/${segment(domain.id)}/records`, "data");
}

export async function listDomains(api: LinodeApi, accountId: string): Promise<ResourceInstance[]> {
  const domains = await api.getAll("/domains", "data");
  return mapPooled(domains, 8, async (domain) => {
    let records: LinodeDomainRecord[] | undefined;
    try {
      records = await recordsOf(api, domain);
    } catch (err) {
      rethrowIncompleteList(err);
    }
    return mapDomain(domain, accountId, records?.length);
  });
}

/** Records are rows of their own, so a failed read has to throw: none would prune them. */
export async function listDomainRecords(
  api: LinodeApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const domains = await api.getAll("/domains", "data");
  const rows = await mapPooled(domains, 8, async (domain) =>
    (await recordsOf(api, domain).catch(noneIfGone)).map((r) =>
      mapDomainRecord(r, domain, accountId),
    ),
  );
  return rows.flat();
}

// --- Images and StackScripts ------------------------------------------------------

export function mapImage(img: LinodeImage, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "image",
    img.id,
    str(img.label || img.id),
    {
      label: str(img.label),
      description: str(img.description),
      status: str(img.status),
      type: str(img.type),
      sizeMb: img.size ?? 0,
      totalSizeBytes: img.total_size ?? 0,
      regions: (img.regions ?? [])
        .map((r) => r.region)
        .filter(Boolean)
        .join(", "),
      cloudInit: (img.capabilities ?? []).includes("cloud-init"),
      expiry: str(img.expiry),
      tags: tags(img.tags),
      created: str(img.created),
    },
    { outputs: { imageId: img.id }, ...(img.created ? { created: img.created } : {}) },
  );
}

export async function listImages(api: LinodeApi, accountId: string): Promise<ResourceInstance[]> {
  const images = await api.getAll("/images", "data", xFilter({ is_public: false }));
  return images.filter((i) => i.is_public !== true).map((i) => mapImage(i, accountId));
}

export function mapStackScript(s: LinodeStackScript, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "stackscript",
    String(s.id),
    str(s.label),
    {
      label: str(s.label),
      description: str(s.description),
      images: (s.images ?? []).join(", "),
      script: str(s.script),
      revNote: str(s.rev_note),
      isPublic: s.is_public === true,
      deploymentsActive: s.deployments_active ?? 0,
      deploymentsTotal: s.deployments_total ?? 0,
      updated: str(s.updated),
    },
    { outputs: { stackscriptId: String(s.id) }, ...(s.created ? { created: s.created } : {}) },
  );
}

export async function listStackScripts(
  api: LinodeApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const scripts = await api.getAll("/linode/stackscripts", "data", xFilter({ mine: true }));
  return scripts.filter((s) => s.mine !== false).map((s) => mapStackScript(s, accountId));
}

// --- Billing ----------------------------------------------------------------------

/** The account id the billing types hang off: one per token, so a fixed key. */
export const ACCOUNT_EXTERNAL_ID = "account";

export function mapAccount(
  a: LinodeAccount,
  transfer: LinodeTransfer | null,
  accountId: string,
): ResourceInstance {
  const promos = a.active_promotions ?? [];
  const promoRemaining = promos.reduce((s, p) => s + (Number(p.credit_remaining ?? 0) || 0), 0);
  const fields: Fields = {
    company: str(a.company),
    email: str(a.email),
    balance: a.balance ?? 0,
    uninvoiced: a.balance_uninvoiced ?? 0,
    promotionCount: promos.length,
    promotionCreditRemaining: Math.round(promoRemaining * 100) / 100,
    billingSource: str(a.billing_source),
    activeSince: str(a.active_since),
  };
  if (transfer) {
    fields["transferUsedGb"] = transfer.used ?? 0;
    fields["transferQuotaGb"] = transfer.quota ?? 0;
    fields["transferBillableGb"] = transfer.billable ?? 0;
  }
  return instance(
    accountId,
    "account",
    ACCOUNT_EXTERNAL_ID,
    a.company || a.email || "Akamai Cloud account",
    fields,
  );
}

export async function listAccount(api: LinodeApi, accountId: string): Promise<ResourceInstance[]> {
  const [account, transfer] = await Promise.all([
    api.get("/account"),
    api.get("/account/transfer").catch(() => null),
  ]);
  return [mapAccount(account, transfer, accountId)];
}

export function mapInvoice(inv: LinodeInvoice, accountId: string): ResourceInstance {
  return instance(
    accountId,
    "invoice",
    String(inv.id),
    str(inv.label || `Invoice #${inv.id}`),
    {
      label: str(inv.label || `Invoice #${inv.id}`),
      date: str(inv.date).slice(0, 10),
      subtotal: inv.subtotal ?? 0,
      tax: inv.tax ?? 0,
      total: inv.total ?? 0,
    },
    {
      parentResourceId: `${accountId}:account:${ACCOUNT_EXTERNAL_ID}`,
      ...(inv.date ? { created: inv.date } : {}),
    },
  );
}

export async function listInvoices(api: LinodeApi, accountId: string): Promise<ResourceInstance[]> {
  // The newest 24 months is what the detail view is for; older invoices stay
  // reachable in Cloud Manager. Linode sorts by `X-Filter` `+order_by`.
  const since = new Date(Date.UTC(new Date().getUTCFullYear() - 2, new Date().getUTCMonth(), 1))
    .toISOString()
    .slice(0, 19);
  const invoices = await api.getAll(
    "/account/invoices",
    "data",
    xFilter({ date: { "+gte": since }, "+order_by": "date", "+order": "desc" }),
  );
  return invoices.map((inv) => mapInvoice(inv, accountId));
}
