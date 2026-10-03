import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";

/**
 * Scaleway products the plugin reaches over plain REST rather than an
 * official SDK package: Load Balancer (`lb/v1`), VPC (`vpc/v2`), Serverless
 * Containers (`containers/v1`, GA 2026-04-22), Serverless Functions
 * (`functions/v1beta1`), Container Registry (`registry/v1`), Domains & DNS
 * (`domain/v2beta1`) and Secret Manager (`secret-manager/v1beta1`). Paths and
 * JSON field names follow scaleway-sdk-go's generated `*_sdk.go` sources.
 *
 * Every lister fans out across the regions/zones it is given and drops the
 * ones that fail (a product not offered in a region answers 404/501), the
 * same tolerance the SDK-backed listers have.
 */

export interface ScwRest {
  /** One request against `https://api.scaleway.com{path}`. */
  fetch<T>(path: string, init?: RequestInit): Promise<T>;
  projectId: string;
}

const PAGE_SIZE = 100;

/** Every page of a Scaleway list endpoint (`page`/`page_size`, `total_count`). */
export async function listAll<T>(api: ScwRest, path: string, rootKey: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const data = await api.fetch<Record<string, unknown>>(
      `${path}${sep}page=${page}&page_size=${PAGE_SIZE}`,
    );
    const batch = (data[rootKey] as T[] | undefined) ?? [];
    out.push(...batch);
    const total = Number(data["total_count"] ?? 0);
    if (batch.length < PAGE_SIZE || (total > 0 && out.length >= total)) break;
  }
  return out;
}

function projectQuery(api: ScwRest): string {
  return api.projectId ? `?project_id=${encodeURIComponent(api.projectId)}` : "";
}

async function fanOut<T>(
  locations: string[],
  fn: (location: string) => Promise<T[]>,
): Promise<T[]> {
  const results = await Promise.all(locations.map((l) => fn(l).catch(() => [] as T[])));
  return results.flat();
}

function iso(value: string | null | undefined): string {
  return value ?? new Date().toISOString();
}

function base(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  createdAt: string | null | undefined,
  updatedAt?: string | null,
): Pick<
  ResourceInstance,
  | "id"
  | "pluginId"
  | "resourceTypeId"
  | "accountId"
  | "displayName"
  | "externalId"
  | "secretStates"
  | "createdAt"
  | "updatedAt"
> {
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: "scaleway",
    resourceTypeId: typeId,
    accountId,
    displayName,
    externalId,
    secretStates: [],
    createdAt: iso(createdAt),
    updatedAt: iso(updatedAt ?? createdAt),
  };
}

/** `{location}/{id}` external id → its two parts. */
export function splitScoped(resourceId: string): { location: string; id: string } {
  const externalId = resourceId.split(":").slice(2).join(":");
  const slash = externalId.indexOf("/");
  if (slash < 0) throw new Error(`Cannot parse Scaleway resource ID "${resourceId}"`);
  return { location: externalId.slice(0, slash), id: externalId.slice(slash + 1) };
}

// ── Load Balancer (zonal) ────────────────────────────────────────────────────

interface ScwLb {
  id: string;
  name: string;
  description?: string;
  status?: string;
  type?: string;
  zone?: string;
  ip?: Array<{ id: string; ip_address: string }>;
  tags?: string[];
  frontend_count?: number;
  backend_count?: number;
  private_network_count?: number;
  ssl_compatibility_level?: string;
  created_at?: string;
  updated_at?: string;
}

export function mapLb(lb: ScwLb, zone: string, accountId: string): ResourceInstance {
  const lbZone = lb.zone ?? zone;
  const ips = (lb.ip ?? []).map((ip) => ip.ip_address).filter(Boolean);
  const ipv4 = ips.find((ip) => !ip.includes(":")) ?? "";
  const ipv6 = ips.find((ip) => ip.includes(":")) ?? "";
  return {
    ...base(
      accountId,
      "load-balancer",
      `${lbZone}/${lb.id}`,
      lb.name,
      lb.created_at,
      lb.updated_at,
    ),
    fields: {
      name: lb.name,
      description: lb.description ?? "",
      zone: lbZone,
      type: lb.type ?? "",
      status: lb.status ?? "",
      ipAddresses: ips.join(", "),
      frontendCount: lb.frontend_count ?? 0,
      backendCount: lb.backend_count ?? 0,
      privateNetworkCount: lb.private_network_count ?? 0,
      sslCompatibilityLevel: lb.ssl_compatibility_level ?? "",
      tags: (lb.tags ?? []).join(", "),
    },
    resolvedOutputs: { ipv4, ipv6 },
  };
}

export function listLoadBalancers(
  api: ScwRest,
  zones: string[],
  accountId: string,
): Promise<ResourceInstance[]> {
  return fanOut(zones, async (zone) => {
    const lbs = await listAll<ScwLb>(api, `/lb/v1/zones/${zone}/lbs${projectQuery(api)}`, "lbs");
    return lbs.map((lb) => mapLb(lb, zone, accountId));
  });
}

export async function loadBalancerCreateConfig(
  api: ScwRest,
  zones: Array<{ id: string; label: string; location?: string; flag?: string }>,
): Promise<CreateResourceConfig> {
  const types = await api
    .fetch<{
      lb_types?: Array<{ name: string; description?: string; stock_status?: string }>;
    }>(`/lb/v1/zones/fr-par-1/lb-types`)
    .then((d) => d.lb_types ?? [])
    .catch(() => []);
  const options = types
    .filter((t) => t.stock_status !== "out_of_stock")
    .map((t) => ({
      id: t.name,
      label: t.description ? `${t.name} · ${t.description}` : t.name,
    }));
  const fallback = [
    { id: "LB-S", label: "LB-S" },
    { id: "LB-GP-M", label: "LB-GP-M" },
    { id: "LB-GP-L", label: "LB-GP-L" },
  ];
  const typeOptions = options.length > 0 ? options : fallback;
  return {
    fields: [
      { key: "name", label: "Name", kind: "text", required: true },
      { key: "description", label: "Description", kind: "text", required: false },
      {
        key: "zone",
        label: "Zone",
        kind: "region-picker",
        required: true,
        regions: zones,
        defaultValue: "fr-par-1",
      },
      {
        key: "type",
        label: "Type",
        kind: "select",
        required: true,
        options: typeOptions,
        defaultValue: typeOptions.find((o) => o.id === "LB-S")?.id ?? typeOptions[0]!.id,
      },
      {
        key: "assignIpv6",
        label: "Public IPv6",
        kind: "select",
        required: false,
        defaultValue: "false",
        options: [
          { id: "false", label: "IPv4 only" },
          { id: "true", label: "IPv4 and IPv6" },
        ],
      },
    ],
  };
}

export async function createLoadBalancer(
  api: ScwRest,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const zone = fields["zone"] || "fr-par-1";
  const lb = await api.fetch<ScwLb>(`/lb/v1/zones/${zone}/lbs`, {
    method: "POST",
    body: JSON.stringify({
      ...(api.projectId ? { project_id: api.projectId } : {}),
      name: fields["name"] ?? "",
      description: fields["description"] ?? "",
      type: fields["type"] || "LB-S",
      assign_flexible_ip: true,
      assign_flexible_ipv6: fields["assignIpv6"] === "true",
      ip_ids: [],
      tags: [],
    }),
  });
  return mapLb(lb, zone, accountId);
}

export async function updateLoadBalancer(
  api: ScwRest,
  current: ResourceInstance,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const { location: zone, id } = splitScoped(current.id);
  // PUT replaces name, description, tags and the TLS level together.
  const lb = await api.fetch<ScwLb>(`/lb/v1/zones/${zone}/lbs/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: fields["name"] ?? String(current.fields["name"] ?? ""),
      description: fields["description"] ?? String(current.fields["description"] ?? ""),
      tags: String(fields["tags"] ?? current.fields["tags"] ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      ssl_compatibility_level:
        fields["sslCompatibilityLevel"] ||
        String(current.fields["sslCompatibilityLevel"] ?? "") ||
        "ssl_compatibility_level_intermediate",
    }),
  });
  return mapLb(lb, zone, current.accountId);
}

export async function deleteLoadBalancer(api: ScwRest, resourceId: string): Promise<void> {
  const { location: zone, id } = splitScoped(resourceId);
  // Keep the flexible IP: it is billed separately and may be in DNS.
  await api.fetch<unknown>(`/lb/v1/zones/${zone}/lbs/${id}?release_ip=false`, {
    method: "DELETE",
  });
}

// ── Private Networks (regional, VPC v2) ─────────────────────────────────────

interface ScwPrivateNetwork {
  id: string;
  name: string;
  region?: string;
  vpc_id?: string;
  subnets?: Array<{ subnet: string }>;
  dhcp_enabled?: boolean;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
}

export function mapPrivateNetwork(
  pn: ScwPrivateNetwork,
  region: string,
  accountId: string,
): ResourceInstance {
  const pnRegion = pn.region ?? region;
  return {
    ...base(
      accountId,
      "private-network",
      `${pnRegion}/${pn.id}`,
      pn.name,
      pn.created_at,
      pn.updated_at,
    ),
    fields: {
      name: pn.name,
      region: pnRegion,
      subnets: (pn.subnets ?? []).map((s) => s.subnet).join(", "),
      vpcId: pn.vpc_id ?? "",
      dhcpEnabled: pn.dhcp_enabled ?? false,
      tags: (pn.tags ?? []).join(", "),
    },
    resolvedOutputs: { privateNetworkId: pn.id },
  };
}

export function listPrivateNetworks(
  api: ScwRest,
  regions: string[],
  accountId: string,
): Promise<ResourceInstance[]> {
  return fanOut(regions, async (region) => {
    const pns = await listAll<ScwPrivateNetwork>(
      api,
      `/vpc/v2/regions/${region}/private-networks${projectQuery(api)}`,
      "private_networks",
    );
    return pns.map((pn) => mapPrivateNetwork(pn, region, accountId));
  });
}

export async function createPrivateNetwork(
  api: ScwRest,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const region = fields["region"] || "fr-par";
  const subnets = (fields["subnets"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const pn = await api.fetch<ScwPrivateNetwork>(`/vpc/v2/regions/${region}/private-networks`, {
    method: "POST",
    body: JSON.stringify({
      name: fields["name"] ?? "",
      ...(api.projectId ? { project_id: api.projectId } : {}),
      tags: [],
      subnets,
      default_route_propagation_enabled: false,
    }),
  });
  return mapPrivateNetwork(pn, region, accountId);
}

export async function renamePrivateNetwork(
  api: ScwRest,
  current: ResourceInstance,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const { location: region, id } = splitScoped(current.id);
  if (!fields["name"]) return current;
  const pn = await api.fetch<ScwPrivateNetwork>(
    `/vpc/v2/regions/${region}/private-networks/${id}`,
    { method: "PATCH", body: JSON.stringify({ name: fields["name"] }) },
  );
  return mapPrivateNetwork(pn, region, current.accountId);
}

// ── Serverless Containers (regional, v1) ────────────────────────────────────

interface ScwContainer {
  id: string;
  name: string;
  namespace_id?: string;
  description?: string;
  status?: string;
  error_message?: string | null;
  min_scale?: number;
  max_scale?: number;
  memory_limit_bytes?: number;
  mvcpu_limit?: number;
  image?: string;
  port?: number;
  privacy?: string;
  public_endpoint?: string;
  region?: string;
  created_at?: string;
  updated_at?: string;
}

export function mapContainer(c: ScwContainer, region: string, accountId: string): ResourceInstance {
  const cRegion = c.region ?? region;
  const endpoint = c.public_endpoint
    ? c.public_endpoint.startsWith("http")
      ? c.public_endpoint
      : `https://${c.public_endpoint}`
    : "";
  return {
    ...base(
      accountId,
      "serverless-container",
      `${cRegion}/${c.id}`,
      c.name,
      c.created_at,
      c.updated_at,
    ),
    fields: {
      name: c.name,
      region: cRegion,
      status: c.status ?? "",
      image: c.image ?? "",
      minScale: c.min_scale ?? 0,
      maxScale: c.max_scale ?? 0,
      memoryMb: c.memory_limit_bytes ? Math.round(c.memory_limit_bytes / 1_000_000) : 0,
      vcpu: c.mvcpu_limit ? c.mvcpu_limit / 1000 : 0,
      port: c.port ?? 0,
      privacy: c.privacy ?? "",
      errorMessage: c.error_message ?? "",
      namespaceId: c.namespace_id ?? "",
    },
    resolvedOutputs: { endpoint },
  };
}

export function listContainers(
  api: ScwRest,
  regions: string[],
  accountId: string,
): Promise<ResourceInstance[]> {
  return fanOut(regions, async (region) => {
    const cs = await listAll<ScwContainer>(
      api,
      `/containers/v1/regions/${region}/containers${projectQuery(api)}`,
      "containers",
    );
    return cs.map((c) => mapContainer(c, region, accountId));
  });
}

/** Edit image, scaling and limits; v1 PATCHes only the keys sent. */
export async function updateContainer(
  api: ScwRest,
  current: ResourceInstance,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const { location: region, id } = splitScoped(current.id);
  const body: Record<string, unknown> = {};
  if (fields["image"]) body["image"] = fields["image"];
  if (fields["minScale"] !== undefined && fields["minScale"] !== "") {
    body["min_scale"] = Number(fields["minScale"]);
  }
  if (fields["maxScale"] !== undefined && fields["maxScale"] !== "") {
    body["max_scale"] = Number(fields["maxScale"]);
  }
  if (fields["memoryMb"]) body["memory_limit_bytes"] = Number(fields["memoryMb"]) * 1_000_000;
  if (fields["vcpu"]) body["mvcpu_limit"] = Math.round(Number(fields["vcpu"]) * 1000);
  if (fields["port"]) body["port"] = Number(fields["port"]);
  if (Object.keys(body).length === 0) return current;
  const c = await api.fetch<ScwContainer>(`/containers/v1/regions/${region}/containers/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return mapContainer(c, region, current.accountId);
}

export async function redeployContainer(api: ScwRest, resourceId: string): Promise<void> {
  const { location: region, id } = splitScoped(resourceId);
  await api.fetch<unknown>(`/containers/v1/regions/${region}/containers/${id}/redeploy`, {
    method: "POST",
    body: "{}",
  });
}

export async function deleteContainer(api: ScwRest, resourceId: string): Promise<void> {
  const { location: region, id } = splitScoped(resourceId);
  await api.fetch<unknown>(`/containers/v1/regions/${region}/containers/${id}`, {
    method: "DELETE",
  });
}

// ── Serverless Functions (regional, v1beta1) ────────────────────────────────

interface ScwFunction {
  id: string;
  name: string;
  namespace_id?: string;
  status?: string;
  runtime?: string;
  handler?: string;
  min_scale?: number;
  max_scale?: number;
  memory_limit?: number;
  privacy?: string;
  domain_name?: string;
  error_message?: string | null;
  region?: string;
  created_at?: string;
  updated_at?: string;
}

export function mapFunction(fn: ScwFunction, region: string, accountId: string): ResourceInstance {
  const fRegion = fn.region ?? region;
  return {
    ...base(
      accountId,
      "serverless-function",
      `${fRegion}/${fn.id}`,
      fn.name,
      fn.created_at,
      fn.updated_at,
    ),
    fields: {
      name: fn.name,
      region: fRegion,
      status: fn.status ?? "",
      runtime: fn.runtime ?? "",
      handler: fn.handler ?? "",
      minScale: fn.min_scale ?? 0,
      maxScale: fn.max_scale ?? 0,
      memoryMb: fn.memory_limit ?? 0,
      privacy: fn.privacy ?? "",
      errorMessage: fn.error_message ?? "",
      namespaceId: fn.namespace_id ?? "",
    },
    resolvedOutputs: { endpoint: fn.domain_name ? `https://${fn.domain_name}` : "" },
  };
}

export function listFunctions(
  api: ScwRest,
  regions: string[],
  accountId: string,
): Promise<ResourceInstance[]> {
  return fanOut(regions, async (region) => {
    const fns = await listAll<ScwFunction>(
      api,
      `/functions/v1beta1/regions/${region}/functions${projectQuery(api)}`,
      "functions",
    );
    return fns.map((fn) => mapFunction(fn, region, accountId));
  });
}

export async function updateFunction(
  api: ScwRest,
  current: ResourceInstance,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const { location: region, id } = splitScoped(current.id);
  const body: Record<string, unknown> = {};
  if (fields["minScale"] !== undefined && fields["minScale"] !== "") {
    body["min_scale"] = Number(fields["minScale"]);
  }
  if (fields["maxScale"] !== undefined && fields["maxScale"] !== "") {
    body["max_scale"] = Number(fields["maxScale"]);
  }
  if (fields["memoryMb"]) body["memory_limit"] = Number(fields["memoryMb"]);
  if (fields["handler"]) body["handler"] = fields["handler"];
  if (Object.keys(body).length === 0) return current;
  const fn = await api.fetch<ScwFunction>(`/functions/v1beta1/regions/${region}/functions/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return mapFunction(fn, region, current.accountId);
}

export async function deployFunction(api: ScwRest, resourceId: string): Promise<void> {
  const { location: region, id } = splitScoped(resourceId);
  await api.fetch<unknown>(`/functions/v1beta1/regions/${region}/functions/${id}/deploy`, {
    method: "POST",
    body: "{}",
  });
}

export async function deleteFunction(api: ScwRest, resourceId: string): Promise<void> {
  const { location: region, id } = splitScoped(resourceId);
  await api.fetch<unknown>(`/functions/v1beta1/regions/${region}/functions/${id}`, {
    method: "DELETE",
  });
}

// ── Container Registry namespaces (regional) ────────────────────────────────

interface ScwRegistryNamespace {
  id: string;
  name: string;
  description?: string;
  status?: string;
  endpoint?: string;
  is_public?: boolean;
  size?: number;
  image_count?: number;
  region?: string;
  created_at?: string;
  updated_at?: string;
}

export function mapRegistryNamespace(
  ns: ScwRegistryNamespace,
  region: string,
  accountId: string,
): ResourceInstance {
  const nsRegion = ns.region ?? region;
  return {
    ...base(
      accountId,
      "registry-namespace",
      `${nsRegion}/${ns.id}`,
      ns.name,
      ns.created_at,
      ns.updated_at,
    ),
    fields: {
      name: ns.name,
      region: nsRegion,
      description: ns.description ?? "",
      status: ns.status ?? "",
      isPublic: ns.is_public ?? false,
      imageCount: ns.image_count ?? 0,
      sizeGb: ns.size ? Math.round((ns.size / 1_000_000_000) * 100) / 100 : 0,
    },
    resolvedOutputs: { endpoint: ns.endpoint ?? "" },
  };
}

export function listRegistryNamespaces(
  api: ScwRest,
  regions: string[],
  accountId: string,
): Promise<ResourceInstance[]> {
  return fanOut(regions, async (region) => {
    const nss = await listAll<ScwRegistryNamespace>(
      api,
      `/registry/v1/regions/${region}/namespaces${projectQuery(api)}`,
      "namespaces",
    );
    return nss.map((ns) => mapRegistryNamespace(ns, region, accountId));
  });
}

export async function createRegistryNamespace(
  api: ScwRest,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const region = fields["region"] || "fr-par";
  const ns = await api.fetch<ScwRegistryNamespace>(`/registry/v1/regions/${region}/namespaces`, {
    method: "POST",
    body: JSON.stringify({
      name: fields["name"] ?? "",
      description: fields["description"] ?? "",
      ...(api.projectId ? { project_id: api.projectId } : {}),
      is_public: fields["isPublic"] === "true",
    }),
  });
  return mapRegistryNamespace(ns, region, accountId);
}

export async function updateRegistryNamespace(
  api: ScwRest,
  current: ResourceInstance,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const { location: region, id } = splitScoped(current.id);
  const body: Record<string, unknown> = {};
  if (fields["description"] !== undefined) body["description"] = fields["description"];
  if (fields["isPublic"] !== undefined) body["is_public"] = fields["isPublic"] === "true";
  if (Object.keys(body).length === 0) return current;
  const ns = await api.fetch<ScwRegistryNamespace>(
    `/registry/v1/regions/${region}/namespaces/${id}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
  return mapRegistryNamespace(ns, region, current.accountId);
}

export async function deleteRegistryNamespace(api: ScwRest, resourceId: string): Promise<void> {
  const { location: region, id } = splitScoped(resourceId);
  await api.fetch<unknown>(`/registry/v1/regions/${region}/namespaces/${id}`, {
    method: "DELETE",
  });
}

// ── Secret Manager (regional) ────────────────────────────────────────────────

interface ScwSecret {
  id: string;
  name: string;
  status?: string;
  type?: string;
  path?: string;
  version_count?: number;
  description?: string | null;
  protected?: boolean;
  managed?: boolean;
  region?: string;
  created_at?: string;
  updated_at?: string;
}

export function mapSecret(s: ScwSecret, region: string, accountId: string): ResourceInstance {
  const sRegion = s.region ?? region;
  return {
    ...base(accountId, "secret", `${sRegion}/${s.id}`, s.name, s.created_at, s.updated_at),
    fields: {
      name: s.name,
      region: sRegion,
      path: s.path ?? "/",
      type: s.type ?? "",
      status: s.status ?? "",
      versionCount: s.version_count ?? 0,
      description: s.description ?? "",
      protected: s.protected ?? false,
      managed: s.managed ?? false,
      updatedAt: s.updated_at ?? "",
    },
    resolvedOutputs: {},
  };
}

export function listSecrets(
  api: ScwRest,
  regions: string[],
  accountId: string,
): Promise<ResourceInstance[]> {
  return fanOut(regions, async (region) => {
    const secrets = await listAll<ScwSecret>(
      api,
      `/secret-manager/v1beta1/regions/${region}/secrets${projectQuery(api)}`,
      "secrets",
    );
    return secrets.map((s) => mapSecret(s, region, accountId));
  });
}

export async function deleteSecret(api: ScwRest, resourceId: string): Promise<void> {
  const { location: region, id } = splitScoped(resourceId);
  await api.fetch<unknown>(`/secret-manager/v1beta1/regions/${region}/secrets/${id}`, {
    method: "DELETE",
  });
}

// ── Domains & DNS (global) ───────────────────────────────────────────────────

interface ScwDnsZone {
  domain: string;
  subdomain?: string;
  ns?: string[];
  ns_default?: string[];
  status?: string;
  message?: string | null;
  updated_at?: string;
  project_id?: string;
}

interface ScwDnsRecord {
  id: string;
  name: string;
  type: string;
  data: string;
  ttl?: number;
  priority?: number;
  comment?: string | null;
}

/** A zone's FQDN, which is also its API identifier. */
function zoneFqdn(z: ScwDnsZone): string {
  return z.subdomain ? `${z.subdomain}.${z.domain}` : z.domain;
}

export function mapDnsZone(z: ScwDnsZone, accountId: string): ResourceInstance {
  const fqdn = zoneFqdn(z);
  const ns = (z.ns ?? []).join(", ");
  return {
    ...base(accountId, "dns-zone", fqdn, fqdn, z.updated_at, z.updated_at),
    fields: {
      name: fqdn,
      domain: z.domain,
      subdomain: z.subdomain ?? "",
      status: z.status ?? "",
      nameservers: ns,
      message: z.message ?? "",
    },
    resolvedOutputs: { nameservers: ns },
  };
}

function mapDnsRecord(r: ScwDnsRecord, zone: string, accountId: string): ResourceInstance {
  const fqdn = r.name ? `${r.name}.${zone}` : zone;
  return {
    ...base(accountId, "dns-record", `${zone}/${r.id}`, `${r.type} ${fqdn}`, undefined),
    fields: {
      name: r.name || "@",
      type: r.type,
      content: r.data,
      ttl: r.ttl ?? 3600,
      ...(r.priority ? { priority: r.priority } : {}),
      comment: r.comment ?? "",
      zoneName: zone,
    },
    resolvedOutputs: {},
    parentResourceId: `${accountId}:dns-zone:${zone}`,
  };
}

async function listZonesRaw(api: ScwRest): Promise<ScwDnsZone[]> {
  return listAll<ScwDnsZone>(api, `/domain/v2beta1/dns-zones${projectQuery(api)}`, "dns_zones");
}

export async function listDnsZones(api: ScwRest, accountId: string): Promise<ResourceInstance[]> {
  return (await listZonesRaw(api)).map((z) => mapDnsZone(z, accountId));
}

export async function listDnsRecords(api: ScwRest, accountId: string): Promise<ResourceInstance[]> {
  const zones = await listZonesRaw(api);
  return fanOut(zones.map(zoneFqdn), async (zone) => {
    const records = await listAll<ScwDnsRecord>(
      api,
      `/domain/v2beta1/dns-zones/${encodeURIComponent(zone)}/records`,
      "records",
    );
    return records.filter((r) => r.type !== "SOA").map((r) => mapDnsRecord(r, zone, accountId));
  });
}

export const SCW_DNS_RECORD_TYPES = [
  "A",
  "AAAA",
  "CNAME",
  "TXT",
  "SRV",
  "TLSA",
  "MX",
  "NS",
  "PTR",
  "CAA",
  "ALIAS",
  "LOC",
  "SVCB",
  "HTTPS",
];

export async function dnsRecordCreateConfig(
  api: ScwRest,
  parentResourceId?: string,
): Promise<CreateResourceConfig> {
  const fields: CreateResourceConfig["fields"] = [];
  if (!parentResourceId) {
    const zones = await listZonesRaw(api).catch(() => [] as ScwDnsZone[]);
    const options = zones.map((z) => ({ id: zoneFqdn(z), label: zoneFqdn(z) }));
    fields.push({
      key: "zoneName",
      label: "Zone",
      kind: "select",
      required: true,
      options,
      ...(options[0] ? { defaultValue: options[0].id } : {}),
    });
  }
  fields.push(
    {
      key: "type",
      label: "Record Type",
      kind: "select",
      required: true,
      options: SCW_DNS_RECORD_TYPES.map((t) => ({ id: t, label: t })),
      defaultValue: "A",
    },
    {
      key: "name",
      label: "Name",
      kind: "text",
      required: false,
      description: "Relative to the zone, e.g. www. Leave empty for the zone apex",
    },
    { key: "content", label: "Value", kind: "text", required: true },
    {
      key: "ttl",
      label: "TTL",
      kind: "number",
      required: false,
      defaultValue: "3600",
      minValue: 60,
    },
    {
      key: "priority",
      label: "Priority",
      kind: "number",
      required: false,
      showWhen: { fieldKey: "type", fieldValues: ["MX", "SRV"] },
    },
  );
  return { fields };
}

function recordBody(fields: Record<string, string>, current?: ResourceInstance) {
  const pick = (k: string) => fields[k] ?? (current ? String(current.fields[k] ?? "") : "");
  const name = pick("name");
  return {
    name: name === "@" ? "" : name,
    type: pick("type") || "A",
    data: pick("content"),
    ttl: Number(pick("ttl") || 3600),
    priority: Number(pick("priority") || 0),
  };
}

async function patchRecords(api: ScwRest, zone: string, changes: unknown[]) {
  return api.fetch<{ records?: ScwDnsRecord[] }>(
    `/domain/v2beta1/dns-zones/${encodeURIComponent(zone)}/records`,
    {
      method: "PATCH",
      body: JSON.stringify({
        changes,
        return_all_records: false,
        disallow_new_zone_creation: true,
      }),
    },
  );
}

export async function createDnsRecord(
  api: ScwRest,
  accountId: string,
  fields: Record<string, string>,
  parentResourceId?: string,
): Promise<ResourceInstance> {
  const zone = fields["zoneName"] || (parentResourceId?.split(":").slice(2).join(":") ?? "");
  if (!zone) throw new Error("Scaleway plugin: a DNS zone is required to create a record");
  const record = recordBody(fields);
  const data = await patchRecords(api, zone, [{ add: { records: [record] } }]);
  const created =
    data.records?.find((r) => r.type === record.type && r.data === record.data) ??
    data.records?.[0];
  if (!created) throw new Error("Scaleway plugin: the DNS API returned no record");
  return mapDnsRecord(created, zone, accountId);
}

export async function updateDnsRecord(
  api: ScwRest,
  current: ResourceInstance,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const { location: zone, id } = splitScoped(current.id);
  const record = recordBody(fields, current);
  const data = await patchRecords(api, zone, [{ set: { id, records: [record] } }]);
  const updated = data.records?.[0];
  return updated ? mapDnsRecord(updated, zone, current.accountId) : current;
}

export async function deleteDnsRecord(api: ScwRest, resourceId: string): Promise<void> {
  const { location: zone, id } = splitScoped(resourceId);
  await patchRecords(api, zone, [{ delete: { id } }]);
}

export async function createDnsZone(
  api: ScwRest,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const z = await api.fetch<ScwDnsZone>(`/domain/v2beta1/dns-zones`, {
    method: "POST",
    body: JSON.stringify({
      domain: (fields["domain"] ?? "").trim().toLowerCase(),
      subdomain: (fields["subdomain"] ?? "").trim().toLowerCase(),
      project_id: api.projectId,
    }),
  });
  return mapDnsZone(z, accountId);
}

export async function deleteDnsZone(api: ScwRest, resourceId: string): Promise<void> {
  const zone = resourceId.split(":").slice(2).join(":");
  const qs = api.projectId ? `?project_id=${encodeURIComponent(api.projectId)}` : "";
  await api.fetch<unknown>(`/domain/v2beta1/dns-zones/${encodeURIComponent(zone)}${qs}`, {
    method: "DELETE",
  });
}
