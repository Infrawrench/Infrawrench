/**
 * Nomad API shapes, named from the generated types, and their mapping to
 * `ResourceInstance`s.
 */
import type { ApiListItem, ApiResponse, ResourceInstance } from "@infrawrench/plugin-base";
import { joinId, nsToIso } from "./api.js";
import type { operations } from "./api-types.gen.js";

export const PLUGIN_ID = "nomad";

type Job = ApiResponse<operations["GetJob"]>;

/** A list row, or a full job read the same way. Only the full job has its groups and version. */
export type JobStub = ApiListItem<operations["GetJobs"], null> &
  Pick<Job, "TaskGroups" | "Version">;

/**
 * What Nomad's own `Job.Stub()` makes of a full job: there these two are a config
 * object or null, on a list row they say yes or no, and a dispatched child of a
 * parameterized job is not itself parameterized.
 */
export function jobRow(job: Job, summary?: JobStub["JobSummary"]): JobStub {
  const { Periodic, ParameterizedJob, ...rest } = job;
  return {
    ...rest,
    Periodic: Boolean(Periodic),
    ParameterizedJob: Boolean(ParameterizedJob) && !job.Dispatched,
    ...(summary ? { JobSummary: summary } : {}),
  };
}

export type AllocStub = ApiListItem<operations["GetAllocations"], null>;

export type Deployment = ApiResponse<operations["GetDeployment"]>;

export type NodeStub = ApiListItem<operations["GetNodes"], null>;

export type Variable = ApiResponse<operations["GetVariableQuery"]>;

export type AclToken = ApiResponse<operations["GetACLToken"]>;

/** A CSI volume or a host volume, which share one mapper. */
export type Volume = ApiResponse<operations["GetVolumeOfType"]>;

export type CsiPlugin = ApiResponse<operations["GetPluginCSI"]>;

type FieldValue = string | number | boolean | undefined | null;

function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, FieldValue>,
  extra: Partial<ResourceInstance> = {},
): ResourceInstance {
  const now = new Date().toISOString();
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) clean[k] = v;
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: clean,
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

export const metaText = (m: Record<string, string> | null | undefined): string =>
  Object.entries(m ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");

export function parseMeta(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? "").split(/[,\n]/)) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export const jobRef = (accountId: string, ns: string, id: string) =>
  `${accountId}:nomad-job:${joinId(ns, id)}`;

export function mapJob(accountId: string, j: JobStub): ResourceInstance {
  const ns = j.Namespace ?? "default";
  const id = j.ID ?? "";
  const summary = Object.values(j.JobSummary?.Summary ?? {});
  const sum = (k: "Running" | "Queued" | "Failed" | "Lost") =>
    summary.reduce((a, s) => a + (s[k] ?? 0), 0);
  const groups = j.JobSummary?.Summary
    ? Object.keys(j.JobSummary.Summary)
    : (j.TaskGroups ?? []).map((g) => g.Name ?? "");
  return instance(accountId, "nomad-job", joinId(ns, id), j.Name || id, {
    namespace: ns,
    id,
    name: j.Name,
    type: j.Type,
    status: j.Status,
    statusDescription: j.StatusDescription,
    priority: j.Priority,
    datacenters: (j.Datacenters ?? []).join(", "),
    nodePool: j.NodePool,
    version: j.Version,
    stopped: j.Stop,
    periodic: j.Periodic,
    parameterized: j.ParameterizedJob,
    parentId: j.ParentID || undefined,
    groups: groups.join(", "),
    running: summary.length ? sum("Running") : undefined,
    queued: summary.length ? sum("Queued") : undefined,
    failed: summary.length ? sum("Failed") : undefined,
    lost: summary.length ? sum("Lost") : undefined,
    submitTime: nsToIso(j.SubmitTime),
  });
}

export function mapAllocation(accountId: string, a: AllocStub): ResourceInstance {
  const ns = a.Namespace ?? "default";
  const tasks = Object.entries(a.TaskStates ?? {});
  const health = a.DeploymentStatus?.Healthy;
  return instance(
    accountId,
    "nomad-allocation",
    a.ID ?? "",
    `${a.Name ?? a.ID ?? ""}`,
    {
      namespace: ns,
      id: a.ID,
      name: a.Name,
      jobId: a.JobID,
      jobVersion: a.JobVersion,
      taskGroup: a.TaskGroup,
      node: a.NodeName,
      nodeId: a.NodeID,
      clientStatus: a.ClientStatus,
      desiredStatus: a.DesiredStatus,
      tasks: tasks.map(([n, s]) => `${n}: ${s.State ?? "?"}`).join(", "),
      restarts: tasks.reduce((n, [, s]) => n + (s.Restarts ?? 0), 0),
      deploymentHealthy: health === true ? "healthy" : health === false ? "unhealthy" : undefined,
      createTime: nsToIso(a.CreateTime),
      modifyTime: nsToIso(a.ModifyTime),
    },
    a.JobID ? { parentResourceId: jobRef(accountId, ns, a.JobID) } : {},
  );
}

export function mapDeployment(accountId: string, d: Deployment): ResourceInstance {
  const ns = d.Namespace ?? "default";
  const groups = Object.entries(d.TaskGroups ?? {});
  const total = (k: "DesiredTotal" | "PlacedAllocs" | "HealthyAllocs" | "UnhealthyAllocs") =>
    groups.reduce((n, [, g]) => n + (g[k] ?? 0), 0);
  return instance(
    accountId,
    "nomad-deployment",
    d.ID ?? "",
    `${d.JobID ?? ""} v${d.JobVersion ?? "?"}`,
    {
      namespace: ns,
      id: d.ID,
      jobId: d.JobID,
      jobVersion: d.JobVersion,
      status: d.Status,
      statusDescription: d.StatusDescription,
      groups: groups.map(([n]) => n).join(", "),
      desired: total("DesiredTotal"),
      placed: total("PlacedAllocs"),
      healthy: total("HealthyAllocs"),
      unhealthy: total("UnhealthyAllocs"),
      canariesPending: groups.filter(([, g]) => (g.DesiredCanaries ?? 0) > 0 && !g.Promoted).length,
    },
    d.JobID ? { parentResourceId: jobRef(accountId, ns, d.JobID) } : {},
  );
}

export function mapNode(accountId: string, n: NodeStub, allocations?: number): ResourceInstance {
  const r = instance(accountId, "nomad-node", n.ID ?? "", n.Name ?? n.ID ?? "", {
    name: n.Name,
    datacenter: n.Datacenter,
    nodeClass: n.NodeClass,
    nodePool: n.NodePool,
    status: n.Status,
    drain: n.Drain,
    eligibility: n.SchedulingEligibility,
    address: n.Address,
    version: n.Version,
    drivers: Object.entries(n.Drivers ?? {})
      .filter(([, d]) => d.Healthy)
      .map(([k]) => k)
      .join(", "),
    cpuMhz: n.NodeResources?.Cpu?.CpuShares,
    cores: n.NodeResources?.Cpu?.TotalCpuCores,
    memoryMb: n.NodeResources?.Memory?.MemoryMB,
    diskMb: n.NodeResources?.Disk?.DiskMB,
    allocations,
  });
  r.resolvedOutputs = { address: n.Address ?? "", name: n.Name ?? "" };
  return r;
}

export function mapVariable(accountId: string, v: Variable): ResourceInstance {
  const ns = v.Namespace ?? "default";
  const path = v.Path ?? "";
  const keys = v.Items ? Object.keys(v.Items) : undefined;
  return instance(accountId, "nomad-variable", joinId(ns, path), path, {
    namespace: ns,
    path,
    keys: keys?.join(", "),
    items: keys?.length,
    modifyTime: nsToIso(v.ModifyTime),
  });
}

export function mapToken(accountId: string, t: AclToken): ResourceInstance {
  const exp =
    t.ExpirationTime && !t.ExpirationTime.startsWith("0001") ? t.ExpirationTime : undefined;
  return instance(accountId, "nomad-acl-token", t.AccessorID ?? "", t.Name || t.AccessorID || "", {
    accessorId: t.AccessorID,
    name: t.Name,
    type: t.Type,
    policies: (t.Policies ?? []).join(", "),
    roles: (t.Roles ?? []).map((r) => r.Name ?? r.ID).join(", "),
    global: t.Global,
    createTime: t.CreateTime,
    expirationTime: exp,
  });
}

export function mapVolume(accountId: string, v: Volume, type: string): ResourceInstance {
  const ns = v.Namespace ?? "default";
  return instance(accountId, "nomad-volume", joinId(type, ns, v.ID ?? ""), v.Name || v.ID || "", {
    namespace: ns,
    id: v.ID,
    name: v.Name,
    type,
    pluginId: v.PluginID,
    provider: v.Provider,
    state: v.State,
    schedulable: v.Schedulable,
    accessMode: v.AccessMode,
    attachmentMode: v.AttachmentMode,
    capacityBytes: v.CapacityBytes ?? v.Capacity,
    nodeId: v.NodeID,
    health:
      type === "csi"
        ? `${v.ControllersHealthy ?? 0}/${v.ControllersExpected ?? 0} controllers, ${v.NodesHealthy ?? 0}/${v.NodesExpected ?? 0} nodes`
        : undefined,
  });
}

export function mapCsiPlugin(accountId: string, p: CsiPlugin): ResourceInstance {
  return instance(accountId, "nomad-csi-plugin", p.ID ?? "", p.ID ?? "", {
    id: p.ID,
    provider: p.Provider,
    version: p.Version,
    controllerRequired: p.ControllerRequired,
    controllers: `${p.ControllersHealthy ?? 0}/${p.ControllersExpected ?? 0}`,
    nodes: `${p.NodesHealthy ?? 0}/${p.NodesExpected ?? 0}`,
  });
}

export function mapService(
  accountId: string,
  ns: string,
  name: string,
  tags: string[],
  instances?: number,
): ResourceInstance {
  return instance(accountId, "nomad-service", joinId(ns, name), name, {
    namespace: ns,
    name,
    tags: tags.join(", "),
    instances,
  });
}
