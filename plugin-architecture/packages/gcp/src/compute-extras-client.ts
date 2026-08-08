import type { ResourceInstance } from "@infrawrench/plugin-base";
import { formatGcpError } from "./utils.js";
import { gcpApiError } from "./api-error.js";
import type { GcpClientContext } from "./shared.js";

interface ManagedInstanceSummary {
  name: string;
  zone: string;
  externalId: string;
  resourceId: string;
  status: string;
  currentAction: string;
}

/**
 * Fetch the VMs currently managed by an instance group. Returns an empty
 * array for unmanaged groups (zone+region both empty) or on any API error.
 * Each entry has enough info to construct a GCE instance resource id and a
 * minimal dashboard card.
 */
export async function listManagedInstances(
  ctx: GcpClientContext,
  resource: ResourceInstance,
): Promise<ManagedInstanceSummary[]> {
  const p = ctx.project;
  const zone = String(resource.fields["zone"] ?? "");
  const region = String(resource.fields["region"] ?? "");
  const groupName = String(resource.fields["name"] ?? "");
  if (!groupName || (!zone && !region)) return [];
  const base = zone
    ? `https://compute.googleapis.com/compute/v1/projects/${p}/zones/${zone}/instanceGroupManagers/${groupName}`
    : `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/instanceGroupManagers/${groupName}`;
  const tok = await ctx.token();
  const res = await fetch(`${base}/listManagedInstances`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    throw gcpApiError(res.status, `${base}/listManagedInstances`, await res.text(), p);
  }
  const data = (await res.json()) as {
    managedInstances?: Array<{
      instance?: string;
      instanceStatus?: string;
      currentAction?: string;
    }>;
  };
  const results: ManagedInstanceSummary[] = [];
  for (const m of data.managedInstances ?? []) {
    const fullUrl = String(m.instance ?? "");
    // Format: https://www.googleapis.com/compute/v1/projects/{p}/zones/{zone}/instances/{name}
    const match = fullUrl.match(/\/zones\/([^/]+)\/instances\/([^/]+)$/);
    if (!match) continue;
    const [, instZone, instName] = match;
    const externalId = `${p}/${instZone}/${instName}`;
    results.push({
      name: instName!,
      zone: instZone!,
      externalId,
      resourceId: ctx.id(resource.accountId, "gce-instance", externalId),
      status: String(m.instanceStatus ?? ""),
      currentAction: String(m.currentAction ?? "NONE"),
    });
  }
  return results;
}

/**
 * Fetch the first page of tasks (up to 50) for a Cloud Tasks queue. Returned
 * tasks include scheduling, dispatch count, and HTTP target URL when present.
 * The Tasks API only exposes a "BASIC" or "FULL" view; we ask for FULL so the
 * Tasks tab can show the request URL.
 */
export async function listCloudTasksQueueTasks(
  ctx: GcpClientContext,
  resource: ResourceInstance,
): Promise<{
  items: Array<{
    name: string;
    shortName: string;
    scheduleTime: string;
    createTime: string;
    dispatchCount: number;
    responseCount: number;
    url: string;
    method: string;
  }>;
  error?: string;
}> {
  const fullName = resource.externalId ?? "";
  if (!fullName) return { items: [] };
  const url = new URL(`https://cloudtasks.googleapis.com/v2/${fullName}/tasks`);
  url.searchParams.set("pageSize", "50");
  url.searchParams.set("responseView", "FULL");
  const data = await ctx.get<{
    tasks?: Array<Record<string, unknown>>;
  }>(url.toString());
  const items = (data.tasks ?? []).map((t) => {
    const name = String(t["name"] ?? "");
    const shortName = name.split("/").pop() ?? name;
    const httpRequest = (t["httpRequest"] ?? t["appEngineHttpRequest"]) as
      Record<string, unknown> | undefined;
    return {
      name,
      shortName,
      scheduleTime: String(t["scheduleTime"] ?? ""),
      createTime: String(t["createTime"] ?? ""),
      dispatchCount: Number(t["dispatchCount"] ?? 0),
      responseCount: Number(t["responseCount"] ?? 0),
      url: String(httpRequest?.["url"] ?? httpRequest?.["relativeUri"] ?? ""),
      method: String(httpRequest?.["httpMethod"] ?? ""),
    };
  });
  return { items };
}

/**
 * Fetch the full Cloud Router record so the detail view can render BGP
 * advertisements, BGP peers, and embedded NAT gateway configs. The
 * top-level lister returns a slim summary; this round-trips for the rest.
 */
export async function fetchCloudRouterFull(
  ctx: GcpClientContext,
  resource: ResourceInstance,
): Promise<Record<string, unknown>> {
  const p = ctx.project;
  const region = String(resource.fields["region"] ?? "");
  const name = String(resource.fields["name"] ?? resource.displayName);
  if (!region || !name) return {};
  return ctx.get<Record<string, unknown>>(
    `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/routers/${name}`,
  );
}

/**
 * List BGP route policies attached to a Cloud Router. The API returns 404
 * (or 400) on routers in regions where the feature isn't available; the
 * caller catches and surfaces an empty list in that case.
 */
export async function listCloudRouterRoutePolicies(
  ctx: GcpClientContext,
  resource: ResourceInstance,
): Promise<{
  result: Array<{ name: string; type: string; terms?: unknown[]; fingerprint?: string }>;
}> {
  const p = ctx.project;
  const region = String(resource.fields["region"] ?? "");
  const name = String(resource.fields["name"] ?? resource.displayName);
  if (!region || !name) return { result: [] };
  return ctx.get<{
    result: Array<{ name: string; type: string; terms?: unknown[]; fingerprint?: string }>;
  }>(
    `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/routers/${name}/listRoutePolicies`,
  );
}

/**
 * Fetch the router that hosts a given Cloud NAT. The full router config
 * carries every NAT setting (timeouts, port allocation, log config), since
 * Cloud NAT is a sub-resource of the router rather than a top-level entity.
 */
export async function fetchCloudNatRouter(
  ctx: GcpClientContext,
  resource: ResourceInstance,
): Promise<Record<string, unknown>> {
  const p = ctx.project;
  const region = String(resource.fields["region"] ?? "");
  const router = String(resource.fields["router"] ?? "");
  if (!region || !router) return {};
  return ctx.get<Record<string, unknown>>(
    `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/routers/${router}`,
  );
}

/**
 * Fetch the router status, which includes per-NAT runtime info: allocated
 * IPs (auto + user), VM endpoint count, and minExtraNatIpsNeeded. Used to
 * render the "Allocated external IP addresses" panel.
 */
export async function fetchCloudNatRouterStatus(
  ctx: GcpClientContext,
  resource: ResourceInstance,
): Promise<Record<string, unknown>> {
  const p = ctx.project;
  const region = String(resource.fields["region"] ?? "");
  const router = String(resource.fields["router"] ?? "");
  if (!region || !router) return {};
  return ctx.get<Record<string, unknown>>(
    `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/routers/${router}/getRouterStatus`,
  );
}

/**
 * Start or stop a GCE VM instance — the detail-page power actions and the
 * sleep/wake schedule lifecycle pair. `stop` moves the VM to TERMINATED
 * (compute billing stops; disks and static IPs keep billing), `start` boots
 * a TERMINATED VM again.
 */
export async function setGceInstancePower(
  ctx: GcpClientContext,
  resource: ResourceInstance,
  verb: "start" | "stop",
): Promise<void> {
  const p = ctx.project;
  const zone = String(resource.fields["zone"] ?? "");
  const name = String(resource.fields["name"] ?? "");
  if (!zone || !name) {
    throw new Error("Cannot determine zone/name for VM instance");
  }
  const tok = await ctx.token();
  const res = await fetch(
    `https://compute.googleapis.com/compute/v1/projects/${p}/zones/${zone}/instances/${name}/${verb}`,
    { method: "POST", headers: { Authorization: `Bearer ${tok}` } },
  );
  if (!res.ok) {
    throw new Error(await formatGcpError(verb === "start" ? "Start VM" : "Stop VM", res));
  }
}

/**
 * Change a stopped instance's machine type — the right-sizing apply path.
 * GCE only accepts `setMachineType` while the instance is TERMINATED; a
 * running instance gets the API's own 400, surfaced as-is.
 */
export async function setGceInstanceMachineType(
  ctx: GcpClientContext,
  resource: ResourceInstance,
  machineType: string,
): Promise<void> {
  const p = ctx.project;
  const zone = String(resource.fields["zone"] ?? "");
  const name = String(resource.fields["name"] ?? "");
  if (!zone || !name) {
    throw new Error("Cannot determine zone/name for VM instance");
  }
  const tok = await ctx.token();
  const res = await fetch(
    `https://compute.googleapis.com/compute/v1/projects/${p}/zones/${zone}/instances/${name}/setMachineType`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ machineType: `zones/${zone}/machineTypes/${machineType}` }),
    },
  );
  if (!res.ok) {
    throw new Error(await formatGcpError("Set machine type", res));
  }
}

/**
 * Run the "restart/replace" action on an instance group — used by the
 * sidebar action button to roll over every VM.
 */
export async function restartReplaceInstanceGroup(
  ctx: GcpClientContext,
  resource: ResourceInstance,
): Promise<void> {
  const p = ctx.project;
  const zone = String(resource.fields["zone"] ?? "");
  const region = String(resource.fields["region"] ?? "");
  const groupName = String(resource.fields["name"] ?? "");
  if (!groupName || (!zone && !region)) {
    throw new Error("Cannot determine zone/region for instance group");
  }
  const managed = await listManagedInstances(ctx, resource);
  if (managed.length === 0) {
    throw new Error("No VMs in this instance group to restart/replace.");
  }
  const base = zone
    ? `https://compute.googleapis.com/compute/v1/projects/${p}/zones/${zone}/instanceGroupManagers/${groupName}`
    : `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/instanceGroupManagers/${groupName}`;
  const tok = await ctx.token();
  const res = await fetch(`${base}/applyUpdatesToInstances`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      instances: managed.map((m) => `zones/${m.zone}/instances/${m.name}`),
      minimalAction: "RESTART",
      mostDisruptiveAllowedAction: "REPLACE",
    }),
  });
  if (!res.ok) {
    throw new Error(await formatGcpError("Restart/replace VMs", res));
  }
}

/**
 * Apply a GCP firewall rule to a GCE instance. GCP firewalls use
 * `targetTags` to select VMs — there's no direct attach. We fetch the
 * firewall's target tags, add them to the instance's tag list, and call
 * the instance's `setTags` API. If the firewall has no targetTags (applies
 * to all VMs in the network), nothing to do.
 */
async function applyFirewallToInstance(
  ctx: GcpClientContext,
  firewall: ResourceInstance,
  instance: ResourceInstance,
): Promise<void> {
  const p = ctx.project;
  const tok = await ctx.token();
  const firewallName = firewall.externalId ?? String(firewall.fields["name"] ?? "");
  const instanceZone = String(instance.fields["zone"] ?? "");
  const instanceName = String(instance.fields["name"] ?? instance.displayName);
  if (!firewallName) throw new Error("Cannot determine firewall name");
  if (!instanceZone || !instanceName) {
    throw new Error("Cannot determine instance zone or name");
  }
  // Fetch the firewall to read its targetTags.
  const fw = await ctx.get<{ targetTags?: string[] }>(
    `https://compute.googleapis.com/compute/v1/projects/${p}/global/firewalls/${firewallName}`,
  );
  const targetTags = fw.targetTags ?? [];
  if (targetTags.length === 0) {
    throw new Error(
      `Firewall "${firewallName}" has no target tags — it already applies to all VMs in its network. No changes needed.`,
    );
  }
  // Fetch the instance to read its current tags (with fingerprint) and tag list.
  const inst = await ctx.get<{ tags?: { fingerprint?: string; items?: string[] } }>(
    `https://compute.googleapis.com/compute/v1/projects/${p}/zones/${instanceZone}/instances/${instanceName}`,
  );
  const currentTags = inst.tags?.items ?? [];
  const merged = Array.from(new Set([...currentTags, ...targetTags]));
  if (merged.length === currentTags.length) return; // all tags already present
  const res = await fetch(
    `https://compute.googleapis.com/compute/v1/projects/${p}/zones/${instanceZone}/instances/${instanceName}/setTags`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        fingerprint: inst.tags?.fingerprint ?? "",
        items: merged,
      }),
    },
  );
  if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
}

function computeBackendServiceUrl(ctx: GcpClientContext, backendService: ResourceInstance): string {
  const p = ctx.project;
  const selfLink = String(backendService.resolvedOutputs["selfLink"] ?? "");
  if (selfLink.includes("/regions/")) {
    const match = selfLink.match(/\/regions\/([^/]+)\/backendServices\/([^/]+)$/);
    if (!match) throw new Error("Cannot determine regional backend service URL");
    return `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${match[1]}/backendServices/${match[2]}`;
  }
  const name = String(backendService.fields["name"] ?? backendService.displayName);
  if (!name) throw new Error("Cannot determine backend service name");
  return `https://compute.googleapis.com/compute/v1/projects/${p}/global/backendServices/${name}`;
}

function instanceGroupSelfLink(ctx: GcpClientContext, group: ResourceInstance): string {
  const p = ctx.project;
  const output = String(group.resolvedOutputs["selfLink"] ?? "");
  if (output) return output;
  const name = String(group.fields["name"] ?? group.displayName);
  const zone = String(group.fields["zone"] ?? "");
  const region = String(group.fields["region"] ?? "");
  if (!name || (!zone && !region)) throw new Error("Cannot determine instance group location");
  return zone
    ? `https://www.googleapis.com/compute/v1/projects/${p}/zones/${zone}/instanceGroups/${name}`
    : `https://www.googleapis.com/compute/v1/projects/${p}/regions/${region}/instanceGroups/${name}`;
}

async function addInstanceGroupToBackendService(
  ctx: GcpClientContext,
  group: ResourceInstance,
  backendService: ResourceInstance,
): Promise<void> {
  const tok = await ctx.token();
  const serviceUrl = computeBackendServiceUrl(ctx, backendService);
  const groupUrl = instanceGroupSelfLink(ctx, group);
  const current = await ctx.get<{
    fingerprint?: string;
    backends?: Array<Record<string, unknown>>;
  }>(serviceUrl);
  const backends = current.backends ?? [];
  if (backends.some((backend) => String(backend["group"]) === groupUrl)) return;
  const res = await fetch(serviceUrl, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fingerprint: current.fingerprint,
      backends: [...backends, { group: groupUrl }],
    }),
  });
  if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
}

/**
 * Attach a disk, static IP, firewall, or Cloud NAT to a target resource.
 * Each pair has its own attachment semantics (see GCP docs).
 */
export async function attachResource(
  ctx: GcpClientContext,
  sourceTypeId: string,
  sourceResourceId: string,
  targetTypeId: string,
  targetResourceId: string,
  accountId: string,
): Promise<void> {
  // Existing attachment path: disk to VM (handled by current code path)
  if (sourceTypeId === "gce-disk" && targetTypeId === "gce-instance") {
    const p = ctx.project;
    const tok = await ctx.token();
    const [disk, instance] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    const diskZone = String(disk.fields["zone"] ?? "");
    const instanceZone = String(instance.fields["zone"] ?? "");
    if (!diskZone || !instanceZone) {
      throw new Error("Cannot determine zone for disk or instance");
    }
    if (diskZone !== instanceZone) {
      throw new Error(
        `Disk zone ${diskZone} does not match instance zone ${instanceZone} — persistent disks must be in the same zone as the instance.`,
      );
    }
    const diskName = String(disk.fields["name"] ?? "");
    const instanceName = String(instance.fields["name"] ?? "");
    if (!diskName || !instanceName) {
      throw new Error("Cannot determine disk or instance name");
    }
    const diskSelfLink = `https://www.googleapis.com/compute/v1/projects/${p}/zones/${diskZone}/disks/${diskName}`;
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/zones/${instanceZone}/instances/${instanceName}/attachDisk`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tok}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ source: diskSelfLink, deviceName: diskName }),
      },
    );
    if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
    return;
  }
  if (sourceTypeId === "static-ip" && targetTypeId === "gce-instance") {
    const p = ctx.project;
    const tok = await ctx.token();
    const [ipResource, instance] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    const ipAddress = String(
      ipResource.fields["address"] ?? ipResource.resolvedOutputs["address"] ?? "",
    );
    const ipVal = ipAddress?.toString?.() ?? "";
    const instanceZone = String(instance.fields["zone"] ?? "");
    const instanceName = String(instance.fields["name"] ?? "");
    if (!ipVal || !instanceZone || !instanceName) {
      throw new Error("Cannot determine IP address or VM for attachment");
    }
    // Attach static IP to the VM's NIC using addAccessConfig (nic0)
    const url = `https://compute.googleapis.com/compute/v1/projects/${p}/zones/${instanceZone}/instances/${instanceName}/addAccessConfig`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tok}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        networkInterface: "nic0",
        type: "ONE_TO_ONE_NAT",
        natIP: ipVal,
        // name can be optional; provide a stable name if needed
        // name: "External NAT",
      }),
    });
    if (!res.ok) {
      throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
    }
    return;
  }
  if (sourceTypeId === "firewall-rule" && targetTypeId === "gce-instance") {
    const [firewall, instance] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    await applyFirewallToInstance(ctx, firewall, instance);
    return;
  }
  if (sourceTypeId === "instance-group" && targetTypeId === "backend-service") {
    const [group, backendService] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    await addInstanceGroupToBackendService(ctx, group, backendService);
    return;
  }
  if (sourceTypeId === "cloud-nat" && targetTypeId === "subnet") {
    const p = ctx.project;
    const tok = await ctx.token();
    const [nat, subnet] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    const region = String(nat.fields["region"] ?? "");
    const routerName = String(nat.fields["router"] ?? "");
    const natName = String(nat.fields["name"] ?? "");
    const subnetRegion = String(subnet.fields["region"] ?? "");
    const subnetName = String(subnet.fields["name"] ?? "");
    if (!region || !routerName || !natName || !subnetName) {
      throw new Error("Cannot determine NAT or subnet identifiers");
    }
    if (region !== subnetRegion) {
      throw new Error(
        `NAT region ${region} does not match subnet region ${subnetRegion} — Cloud NAT only applies to subnets in its own region.`,
      );
    }
    const subnetSelfLink = `https://www.googleapis.com/compute/v1/projects/${p}/regions/${subnetRegion}/subnetworks/${subnetName}`;

    const routerUrl = `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/routers/${routerName}`;
    const router = await ctx.get<Record<string, unknown>>(routerUrl);
    const nats = (router["nats"] as Array<Record<string, unknown>> | undefined) ?? [];
    const idx = nats.findIndex((n) => String(n["name"]) === natName);
    if (idx < 0) throw new Error(`Cloud NAT "${natName}" not found on router "${routerName}"`);
    const target = nats[idx]!;
    const existing = (target["subnetworks"] as Array<Record<string, unknown>> | undefined) ?? [];
    if (existing.some((s) => String(s["name"]) === subnetSelfLink)) {
      // Already attached — nothing to do.
      return;
    }
    target["sourceSubnetworkIpRangesToNat"] = "LIST_OF_SUBNETWORKS";
    target["subnetworks"] = [
      ...existing,
      { name: subnetSelfLink, sourceIpRangesToNat: ["ALL_IP_RANGES"] },
    ];
    nats[idx] = target;

    const res = await fetch(routerUrl, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ nats }),
    });
    if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
    return;
  }
  throw new Error(`GCP plugin: attachResource not supported for ${sourceTypeId} → ${targetTypeId}`);
}
