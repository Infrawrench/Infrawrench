import type {
  CreateResourceConfig,
  DashboardStat,
  ResourceInstance,
  SizeOption,
} from "@infrawrench/plugin-base";

/**
 * Public Cloud features added on top of the original listers: Octavia load
 * balancers, volume snapshots, the Managed Private Registry, instance and
 * Kubernetes lifecycle actions, and the edit paths. Every path and body field
 * is from https://eu.api.ovh.com/1.0/cloud.json (all PRODUCTION status).
 */

export interface OvhApi {
  /** Signed request against the account's API endpoint. */
  fetch<T>(path: string, init?: RequestInit): Promise<T>;
  /** `/cloud/project/{projectId}{suffix}`. */
  cloudPath(suffix: string): string;
  /** Names of the project's activated regions. */
  listUpRegions(): Promise<string[]>;
}

const enc = encodeURIComponent;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function externalIdOf(resourceId: string): string {
  return resourceId.split(":").slice(2).join(":");
}

/** `{region}/{id}` external id → its two parts. */
function splitRegional(resourceId: string): { region: string; id: string } {
  const externalId = externalIdOf(resourceId);
  const slash = externalId.indexOf("/");
  if (slash < 0) throw new Error(`Cannot parse OVH resource ID "${resourceId}"`);
  return { region: externalId.slice(0, slash), id: externalId.slice(slash + 1) };
}

async function perRegion<T>(api: OvhApi, fn: (region: string) => Promise<T[]>): Promise<T[]> {
  const regions = await api.listUpRegions();
  const results = await Promise.all(regions.map((r) => fn(r).catch(() => [] as T[])));
  return results.flat();
}

// ── Octavia load balancers ───────────────────────────────────────────────────

interface OctaviaLb {
  id: string;
  name?: string;
  flavorId?: string;
  provisioningStatus?: string;
  operatingStatus?: string;
  vipAddress?: string;
  vipNetworkId?: string;
  vipSubnetId?: string;
  region?: string;
  createdAt?: string;
  updatedAt?: string;
  floatingIp?: { id?: string; ip?: string } | null;
}

interface OctaviaFlavor {
  id: string;
  name: string;
  region?: string;
}

function lbBase(region: string) {
  return `/region/${enc(region)}/loadbalancing`;
}

export async function listOctaviaLoadBalancers(
  api: OvhApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  return perRegion(api, async (region) => {
    const [lbs, flavors] = await Promise.all([
      api.fetch<OctaviaLb[]>(api.cloudPath(`${lbBase(region)}/loadbalancer`)),
      api
        .fetch<OctaviaFlavor[]>(api.cloudPath(`${lbBase(region)}/flavor`))
        .catch(() => [] as OctaviaFlavor[]),
    ]);
    const flavorNames = new Map(flavors.map((f) => [f.id, f.name]));
    return lbs.map((lb) => mapOctaviaLb(lb, region, flavorNames, accountId));
  });
}

function mapOctaviaLb(
  lb: OctaviaLb,
  region: string,
  flavorNames: Map<string, string>,
  accountId: string,
): ResourceInstance {
  const lbRegion = lb.region ?? region;
  const created = lb.createdAt ?? new Date().toISOString();
  const floatingIp = lb.floatingIp?.ip ?? "";
  return {
    id: `${accountId}:octavia-load-balancer:${lbRegion}/${lb.id}`,
    pluginId: "ovh",
    resourceTypeId: "octavia-load-balancer",
    accountId,
    displayName: lb.name || lb.id,
    fields: {
      name: lb.name ?? "",
      region: lbRegion,
      flavor: (lb.flavorId && flavorNames.get(lb.flavorId)) || lb.flavorId || "",
      provisioningStatus: lb.provisioningStatus ?? "",
      operatingStatus: lb.operatingStatus ?? "",
      vipAddress: lb.vipAddress ?? "",
      floatingIp,
      vipNetworkId: lb.vipNetworkId ?? "",
    },
    resolvedOutputs: { vipAddress: lb.vipAddress ?? "", floatingIp },
    secretStates: [],
    externalId: `${lbRegion}/${lb.id}`,
    createdAt: created,
    updatedAt: lb.updatedAt ?? created,
  };
}

/** Rename and/or resize: the flavor is chosen by name and resolved to its regional id. */
export async function updateOctaviaLoadBalancer(
  api: OvhApi,
  current: ResourceInstance,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const { region, id } = splitRegional(current.id);
  const body: Record<string, unknown> = {};
  if (fields["name"]) body["name"] = fields["name"];
  const flavors = await api
    .fetch<OctaviaFlavor[]>(api.cloudPath(`${lbBase(region)}/flavor`))
    .catch(() => [] as OctaviaFlavor[]);
  if (fields["flavor"]) {
    const flavor = flavors.find(
      (f) => f.name.toLowerCase() === fields["flavor"]!.toLowerCase() || f.id === fields["flavor"],
    );
    if (!flavor) {
      throw new Error(
        `OVH plugin: unknown load balancer size "${fields["flavor"]}" in ${region}; available: ${flavors.map((f) => f.name).join(", ")}`,
      );
    }
    body["flavorId"] = flavor.id;
  }
  if (Object.keys(body).length === 0) return current;
  await api.fetch<unknown>(api.cloudPath(`${lbBase(region)}/loadbalancer/${enc(id)}`), {
    method: "PUT",
    body: JSON.stringify(body),
  });
  const lb = await api.fetch<OctaviaLb>(api.cloudPath(`${lbBase(region)}/loadbalancer/${enc(id)}`));
  return mapOctaviaLb(lb, region, new Map(flavors.map((f) => [f.id, f.name])), current.accountId);
}

export async function deleteOctaviaLoadBalancer(api: OvhApi, resourceId: string): Promise<void> {
  const { region, id } = splitRegional(resourceId);
  await api.fetch<unknown>(api.cloudPath(`${lbBase(region)}/loadbalancer/${enc(id)}`), {
    method: "DELETE",
  });
}

/** Lifetime counters from `/stats` (Octavia keeps no time series). */
export async function octaviaStats(api: OvhApi, resourceId: string): Promise<DashboardStat[]> {
  const { region, id } = splitRegional(resourceId);
  try {
    const s = await api.fetch<{
      activeConnections?: number;
      totalConnections?: number;
      bytesIn?: number;
      bytesOut?: number;
      requestErrors?: number;
    }>(api.cloudPath(`${lbBase(region)}/loadbalancer/${enc(id)}/stats`));
    const gb = (b: number | undefined) => `${((b ?? 0) / 1e9).toFixed(2)} GB`;
    return [
      { label: "Active Connections", value: String(s.activeConnections ?? 0) },
      { label: "Total Connections", value: String(s.totalConnections ?? 0) },
      { label: "Bytes In", value: gb(s.bytesIn) },
      { label: "Bytes Out", value: gb(s.bytesOut) },
      {
        label: "Request Errors",
        value: String(s.requestErrors ?? 0),
        ...((s.requestErrors ?? 0) > 0 ? { variant: "status-degraded" as const } : {}),
      },
    ];
  } catch {
    return [];
  }
}

// ── Volume snapshots ─────────────────────────────────────────────────────────

interface OvhVolumeSnapshot {
  id: string;
  name?: string;
  description?: string;
  region?: string;
  size?: number;
  status?: string;
  volumeId?: string;
  creationDate?: string;
}

export async function listVolumeSnapshots(
  api: OvhApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const snapshots = await api.fetch<OvhVolumeSnapshot[]>(api.cloudPath("/volume/snapshot"));
  return snapshots.map((s) => {
    const created = s.creationDate ?? new Date().toISOString();
    return {
      id: `${accountId}:volume-snapshot:${s.id}`,
      pluginId: "ovh",
      resourceTypeId: "volume-snapshot",
      accountId,
      displayName: s.name || s.id,
      fields: {
        name: s.name ?? "",
        description: s.description ?? "",
        region: s.region ?? "",
        sizeGb: s.size ?? 0,
        status: s.status ?? "",
        volumeId: s.volumeId ?? "",
        createdAt: s.creationDate ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: s.id,
      createdAt: created,
      updatedAt: created,
    };
  });
}

export async function deleteVolumeSnapshot(api: OvhApi, resourceId: string): Promise<void> {
  await api.fetch<unknown>(api.cloudPath(`/volume/snapshot/${enc(externalIdOf(resourceId))}`), {
    method: "DELETE",
  });
}

// ── Managed Private Registry ─────────────────────────────────────────────────

interface OvhRegistry {
  id: string;
  name: string;
  region?: string;
  status?: string;
  size?: number;
  url?: string;
  version?: string;
  iamEnabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface RegistryCapability {
  regionName: string;
  plans?: Array<{
    id: string;
    name: string;
    registryLimits?: { imageStorage?: number; parallelRequest?: number };
  }>;
}

function mapRegistry(r: OvhRegistry, accountId: string): ResourceInstance {
  const created = r.createdAt ?? new Date().toISOString();
  return {
    id: `${accountId}:container-registry:${r.id}`,
    pluginId: "ovh",
    resourceTypeId: "container-registry",
    accountId,
    displayName: r.name,
    fields: {
      name: r.name,
      region: r.region ?? "",
      status: r.status ?? "",
      sizeGb: r.size ? Math.round((r.size / 1e9) * 100) / 100 : 0,
      version: r.version ?? "",
      iamEnabled: r.iamEnabled ?? false,
    },
    resolvedOutputs: { url: r.url ?? "" },
    secretStates: [],
    externalId: r.id,
    createdAt: created,
    updatedAt: r.updatedAt ?? created,
  };
}

export async function listRegistries(api: OvhApi, accountId: string): Promise<ResourceInstance[]> {
  const registries = await api.fetch<OvhRegistry[]>(api.cloudPath("/containerRegistry"));
  return registries.map((r) => mapRegistry(r, accountId));
}

export async function registryCreateConfig(api: OvhApi): Promise<CreateResourceConfig> {
  const caps = await api.fetch<RegistryCapability[]>(
    api.cloudPath("/capabilities/containerRegistry"),
  );
  const planNames = new Map<string, string>();
  for (const cap of caps) {
    for (const plan of cap.plans ?? []) {
      if (planNames.has(plan.name)) continue;
      const storage = plan.registryLimits?.imageStorage;
      planNames.set(
        plan.name,
        storage ? `${plan.name} · ${Math.round(storage / 1e9)} GB` : plan.name,
      );
    }
  }
  const plans = [...planNames.entries()].map(([id, label]) => ({ id, label }));
  return {
    fields: [
      { key: "name", label: "Name", kind: "text", required: true },
      {
        key: "region",
        label: "Region",
        kind: "region-picker",
        required: true,
        regions: caps.map((c) => ({ id: c.regionName, label: c.regionName })),
        ...(caps[0] ? { defaultValue: caps[0].regionName } : {}),
      },
      {
        key: "plan",
        label: "Plan",
        kind: "select",
        required: true,
        options: plans,
        ...(plans[0] ? { defaultValue: plans[0].id } : {}),
      },
    ],
  };
}

export async function createRegistry(
  api: OvhApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const region = fields["region"] ?? "";
  let planID: string | undefined;
  if (fields["plan"]) {
    // Plan ids are per region; the form offers plan names.
    const caps = await api.fetch<RegistryCapability[]>(
      api.cloudPath("/capabilities/containerRegistry"),
    );
    planID = caps
      .find((c) => c.regionName === region)
      ?.plans?.find((p) => p.name === fields["plan"])?.id;
  }
  const registry = await api.fetch<OvhRegistry>(api.cloudPath("/containerRegistry"), {
    method: "POST",
    body: JSON.stringify({ name: fields["name"], region, ...(planID ? { planID } : {}) }),
  });
  return mapRegistry(registry, accountId);
}

export async function deleteRegistry(api: OvhApi, resourceId: string): Promise<void> {
  await api.fetch<unknown>(api.cloudPath(`/containerRegistry/${enc(externalIdOf(resourceId))}`), {
    method: "DELETE",
  });
}

// ── Instance actions and edits ───────────────────────────────────────────────

export const INSTANCE_ACTIONS = new Set([
  "start",
  "stop",
  "reboot",
  "reboot_hard",
  "shelve",
  "unshelve",
  "snapshot",
]);

export async function invokeInstanceAction(
  api: OvhApi,
  resourceId: string,
  actionId: string,
): Promise<void> {
  const id = enc(externalIdOf(resourceId));
  const path = (action: string) => api.cloudPath(`/instance/${id}/${action}`);
  switch (actionId) {
    case "reboot":
    case "reboot_hard":
      await api.fetch<unknown>(path("reboot"), {
        method: "POST",
        body: JSON.stringify({ type: actionId === "reboot_hard" ? "hard" : "soft" }),
      });
      return;
    case "snapshot":
      await api.fetch<unknown>(path("snapshot"), {
        method: "POST",
        body: JSON.stringify({
          snapshotName: `infrawrench-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}`,
        }),
      });
      return;
    default:
      await api.fetch<unknown>(path(actionId), { method: "POST" });
  }
}

interface OvhFlavorLite {
  id: string;
  name: string;
  available?: boolean;
}

/** Rename (`PUT instanceName`) and resize (flavor chosen by name, resolved per region). */
export async function updateInstance(
  api: OvhApi,
  current: ResourceInstance,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const id = enc(externalIdOf(current.id));
  const failures: string[] = [];
  if (fields["name"]) {
    try {
      await api.fetch<unknown>(api.cloudPath(`/instance/${id}`), {
        method: "PUT",
        body: JSON.stringify({ instanceName: fields["name"] }),
      });
    } catch (e) {
      failures.push(`rename failed: ${errorText(e)}`);
    }
  }
  if (fields["flavorName"]) {
    try {
      const region = String(current.fields["region"] ?? "");
      const flavors = await api.fetch<OvhFlavorLite[]>(
        api.cloudPath(`/flavor?region=${enc(region)}`),
      );
      const flavor = flavors.find((f) => f.name === fields["flavorName"]);
      if (!flavor) throw new Error(`flavor "${fields["flavorName"]}" is not offered in ${region}`);
      await api.fetch<unknown>(api.cloudPath(`/instance/${id}/resize`), {
        method: "POST",
        body: JSON.stringify({ flavorId: flavor.id }),
      });
    } catch (e) {
      failures.push(`resize failed: ${errorText(e)}`);
    }
  }
  if (failures.length > 0) throw new Error(`OVH instance update: ${failures.join("; ")}`);
  return {
    ...current,
    ...(fields["name"] ? { displayName: fields["name"] } : {}),
    fields: {
      ...current.fields,
      ...(fields["name"] ? { name: fields["name"] } : {}),
      ...(fields["flavorName"] ? { flavorName: fields["flavorName"], status: "RESIZE" } : {}),
    },
    updatedAt: new Date().toISOString(),
  };
}

// ── Volume edits ─────────────────────────────────────────────────────────────

export async function updateVolume(
  api: OvhApi,
  current: ResourceInstance,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const id = enc(externalIdOf(current.id));
  const failures: string[] = [];
  const meta: Record<string, string> = {};
  if (fields["name"]) meta["name"] = fields["name"];
  if (fields["description"] !== undefined) meta["description"] = fields["description"];
  if (Object.keys(meta).length > 0) {
    try {
      await api.fetch<unknown>(api.cloudPath(`/volume/${id}`), {
        method: "PUT",
        body: JSON.stringify(meta),
      });
    } catch (e) {
      failures.push(`update failed: ${errorText(e)}`);
    }
  }
  const size = fields["sizeGb"] ? Number(fields["sizeGb"]) : undefined;
  if (size !== undefined) {
    const currentSize = Number(current.fields["sizeGb"] ?? 0);
    if (!Number.isFinite(size) || size < currentSize) {
      failures.push(`upsize failed: OVH volumes can only grow (current size ${currentSize} GB)`);
    } else if (size > currentSize) {
      try {
        await api.fetch<unknown>(api.cloudPath(`/volume/${id}/upsize`), {
          method: "POST",
          body: JSON.stringify({ size }),
        });
      } catch (e) {
        failures.push(`upsize failed: ${errorText(e)}`);
      }
    }
  }
  if (failures.length > 0) throw new Error(`OVH volume update: ${failures.join("; ")}`);
  return {
    ...current,
    ...(meta["name"] ? { displayName: meta["name"] } : {}),
    fields: { ...current.fields, ...meta, ...(size !== undefined ? { sizeGb: size } : {}) },
    updatedAt: new Date().toISOString(),
  };
}

export async function snapshotVolume(api: OvhApi, resourceId: string): Promise<void> {
  await api.fetch<unknown>(api.cloudPath(`/volume/${enc(externalIdOf(resourceId))}/snapshot`), {
    method: "POST",
    body: JSON.stringify({
      name: `infrawrench-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}`,
    }),
  });
}

// ── Managed Kubernetes ───────────────────────────────────────────────────────

/** `cloud.kube.VersionEnum`: the versions a new cluster can be created on. */
export const KUBE_VERSIONS = ["1.35", "1.34", "1.33", "1.32", "1.31"];

export const KUBE_ACTIONS = new Set(["update_patch", "update_minor", "reset_kubeconfig"]);

export async function invokeKubeAction(
  api: OvhApi,
  resourceId: string,
  actionId: string,
): Promise<void> {
  const id = enc(externalIdOf(resourceId));
  if (actionId === "reset_kubeconfig") {
    await api.fetch<unknown>(api.cloudPath(`/kube/${id}/kubeconfig/reset`), { method: "POST" });
    return;
  }
  await api.fetch<unknown>(api.cloudPath(`/kube/${id}/update`), {
    method: "POST",
    body: JSON.stringify({ strategy: actionId === "update_minor" ? "NEXT_MINOR" : "LATEST_PATCH" }),
  });
}

export async function updateKube(
  api: OvhApi,
  current: ResourceInstance,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const id = enc(externalIdOf(current.id));
  const failures: string[] = [];
  const body: Record<string, string> = {};
  if (fields["name"]) body["name"] = fields["name"];
  if (fields["updatePolicy"]) body["updatePolicy"] = fields["updatePolicy"];
  if (Object.keys(body).length > 0) {
    try {
      await api.fetch<unknown>(api.cloudPath(`/kube/${id}`), {
        method: "PUT",
        body: JSON.stringify(body),
      });
    } catch (e) {
      failures.push(`update failed: ${errorText(e)}`);
    }
  }
  if (fields["nodeCount"]) {
    try {
      const pools = await api.fetch<
        Array<{ id: string; desiredNodes?: number; minNodes?: number; maxNodes?: number }>
      >(api.cloudPath(`/kube/${id}/nodepool`));
      const first = pools[0];
      if (!first) throw new Error("the cluster has no node pool");
      const others = pools.slice(1).reduce((sum, p) => sum + (p.desiredNodes ?? 0), 0);
      const desired = Number(fields["nodeCount"]) - others;
      if (!Number.isFinite(desired) || desired < 0) {
        throw new Error(`the other pools already hold ${others} nodes`);
      }
      await api.fetch<unknown>(api.cloudPath(`/kube/${id}/nodepool/${enc(first.id)}`), {
        method: "PUT",
        body: JSON.stringify({
          desiredNodes: desired,
          // Keep the autoscaler bounds consistent with the new size.
          ...(first.minNodes !== undefined && first.minNodes > desired
            ? { minNodes: desired }
            : {}),
          ...(first.maxNodes !== undefined && first.maxNodes < desired
            ? { maxNodes: desired }
            : {}),
        }),
      });
    } catch (e) {
      failures.push(`resize failed: ${errorText(e)}`);
    }
  }
  if (failures.length > 0) throw new Error(`OVH Kubernetes update: ${failures.join("; ")}`);
  return {
    ...current,
    ...(body["name"] ? { displayName: body["name"] } : {}),
    fields: {
      ...current.fields,
      ...body,
      ...(fields["nodeCount"] ? { nodeCount: Number(fields["nodeCount"]) } : {}),
    },
    updatedAt: new Date().toISOString(),
  };
}

// ── Managed databases ────────────────────────────────────────────────────────

interface DbCapabilities {
  engines?: Array<{ name: string; defaultVersion?: string; versions?: string[] }>;
  flavors?: Array<{
    name: string;
    core?: number;
    memory?: number;
    storage?: number;
    specifications?: {
      core?: number;
      memory?: { unit?: string; value?: number };
      storage?: { unit?: string; value?: number };
    };
    lifecycle?: { status?: string };
  }>;
  plans?: Array<{ name: string; description?: string; lifecycle?: { status?: string } }>;
  regions?: string[];
}

const ORDERABLE = (status: string | undefined) =>
  status === undefined || status === "STABLE" || status === "BETA";

function toGb(unitValue: { unit?: string; value?: number } | undefined, fallback?: number) {
  if (!unitValue?.value) return fallback ?? 0;
  const unit = (unitValue.unit ?? "GB").toUpperCase();
  if (unit === "MB") return Math.round(unitValue.value / 1024);
  if (unit === "TB") return unitValue.value * 1024;
  return unitValue.value;
}

/**
 * Create form driven by `/database/capabilities`: engines with their versions,
 * orderable plans and flavors, and the database regions (which are not the
 * OpenStack regions: `GRA`, `SBG`, `BHS`, …).
 */
export async function databaseCreateConfig(api: OvhApi): Promise<CreateResourceConfig | null> {
  let caps: DbCapabilities;
  try {
    caps = await api.fetch<DbCapabilities>(api.cloudPath("/database/capabilities"));
  } catch {
    return null;
  }
  const engines = (caps.engines ?? []).filter((e) => (e.versions ?? []).length > 0);
  const engineOptions = engines.map((e) => ({ id: e.name, label: e.name }));
  const versionOptions = [...new Set(engines.flatMap((e) => e.versions ?? []))]
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
    .map((v) => ({ id: v, label: v }));
  const plans = (caps.plans ?? []).filter((p) => ORDERABLE(p.lifecycle?.status));
  const flavors: SizeOption[] = (caps.flavors ?? [])
    .filter((f) => ORDERABLE(f.lifecycle?.status))
    .map((f) => ({
      id: f.name,
      label: f.name,
      vcpus: f.specifications?.core ?? f.core ?? 0,
      memoryMb: toGb(f.specifications?.memory, f.memory) * 1024,
      diskGb: toGb(f.specifications?.storage, f.storage),
      category: f.name.split("-")[0] ?? "Other",
    }));
  const pg = engines.find((e) => e.name === "postgresql");
  return {
    fields: [
      { key: "description", label: "Name / Description", kind: "text", required: true },
      {
        key: "engine",
        label: "Engine",
        kind: "select",
        required: true,
        options: engineOptions,
        ...(engineOptions[0] ? { defaultValue: pg ? "postgresql" : engineOptions[0].id } : {}),
      },
      {
        key: "version",
        label: "Version",
        kind: "select",
        required: true,
        options: versionOptions,
        ...(pg?.defaultVersion ? { defaultValue: pg.defaultVersion } : {}),
        description: "Must be a version the chosen engine offers",
      },
      {
        key: "plan",
        label: "Plan",
        kind: "select",
        required: true,
        options: plans.map((p) => ({
          id: p.name,
          label: p.description ? `${p.name} · ${p.description}` : p.name,
        })),
        ...(plans[0] ? { defaultValue: plans[0].name } : {}),
      },
      {
        key: "flavor",
        label: "Flavor",
        kind: "size-picker",
        required: true,
        sizes: flavors,
        ...(flavors[0] ? { defaultValue: flavors[0].id } : {}),
        description: "Available flavors depend on the engine and plan",
      },
      {
        key: "nodeCount",
        label: "Node Count",
        kind: "number",
        required: true,
        defaultValue: "1",
        minValue: 1,
      },
      {
        key: "region",
        label: "Region",
        kind: "select",
        required: true,
        options: (caps.regions ?? []).map((r) => ({ id: r, label: r })),
        ...(caps.regions?.[0] ? { defaultValue: caps.regions[0] } : {}),
      },
    ],
  };
}

/** `PUT /database/{engine}/{id}` with only the writable fields that changed. */
export async function updateDatabase(
  api: OvhApi,
  current: ResourceInstance,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const id = enc(externalIdOf(current.id));
  const engine = String(current.fields["engine"] ?? "").toLowerCase();
  if (!engine) throw new Error("OVH plugin: managed database engine is unknown");
  const body: Record<string, unknown> = {};
  for (const key of ["description", "version", "plan", "flavor"]) {
    if (fields[key]) body[key] = fields[key];
  }
  if (fields["deletionProtection"] !== undefined) {
    body["deletionProtection"] = fields["deletionProtection"] === "true";
  }
  if (Object.keys(body).length === 0) return current;
  await api.fetch<unknown>(api.cloudPath(`/database/${enc(engine)}/${id}`), {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return {
    ...current,
    ...(typeof body["description"] === "string" ? { displayName: body["description"] } : {}),
    fields: { ...current.fields, ...(body as Record<string, string | boolean>) },
    updatedAt: new Date().toISOString(),
  };
}
