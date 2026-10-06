import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { ParsedSshKey } from "./ssh-keys.js";
import type {
  RpEndpoint,
  RpEndpointHealth,
  RpNetworkVolume,
  RpPod,
  RpPodExtras,
  RpRegistryAuth,
  RpTemplate,
} from "./types.js";

/** Pure mapping from Runpod payloads to host resource instances. */

export const PLUGIN_ID = "runpod";
export const SSH_PROXY_HOST = "ssh.runpod.io";

type Fields = ResourceInstance["fields"];

export function makeInstance(opts: {
  accountId: string;
  typeId: string;
  externalId: string;
  displayName: string;
  fields: Fields;
  outputs?: Record<string, string>;
  createdAt?: string;
}): ResourceInstance {
  const now = new Date().toISOString();
  return {
    id: `${opts.accountId}:${opts.typeId}:${opts.externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: opts.typeId,
    accountId: opts.accountId,
    displayName: opts.displayName,
    fields: opts.fields,
    resolvedOutputs: opts.outputs ?? {},
    secretStates: [],
    externalId: opts.externalId,
    createdAt: opts.createdAt || now,
    updatedAt: now,
    lastSyncedAt: now,
  };
}

/** Bare externalId of a host resource id (`acct:type:ext` → `ext`). */
export function externalOf(resourceId: string): string {
  return resourceId.includes(":") ? resourceId.split(":").slice(2).join(":") : resourceId;
}

export function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function joinList(values: Array<string | undefined | null> | undefined): string {
  return (values ?? []).filter((v): v is string => !!v).join(", ");
}

/**
 * Runpod reports only the *desired* status. A pod that should be running but
 * has no runtime yet (image pulling, host booting) is shown as starting; the
 * runtime is only known when the GraphQL enrichment succeeded, so a missing
 * enrichment reads as running rather than inventing a state.
 */
export function podStatus(desired: string | undefined, extras: RpPodExtras | undefined): string {
  switch (desired) {
    case "RUNNING":
      if (extras && !extras.runtime) return "starting";
      return "running";
    case "EXITED":
      return "stopped";
    case "TERMINATED":
      return "terminated";
    default:
      return "unknown";
  }
}

/** First exposed HTTP port, from `["8888/http", "22/tcp"]`. */
export function firstHttpPort(ports: string[] | undefined): string {
  for (const p of ports ?? []) {
    const [port, proto] = p.split("/");
    if (port && (proto ?? "").toLowerCase() === "http") return port.trim();
  }
  return "";
}

function avg(values: Array<number | undefined>): number | undefined {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return undefined;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10;
}

export function mapPod(
  pod: RpPod,
  accountId: string,
  extras: RpPodExtras | undefined,
): ResourceInstance {
  const machine = pod.machine;
  const region = machine?.dataCenterId || extras?.machine?.dataCenterId || "";
  const secure = machine?.secureCloud ?? extras?.machine?.secureCloud;
  const gpuCount = pod.gpu?.count ?? 0;
  const status = podStatus(pod.desiredStatus, extras);
  const podHostId = extras?.machine?.podHostId ?? "";
  const sshUser = podHostId ? `${pod.id}-${podHostId}` : "";
  const sshPort = pod.portMappings?.["22"];
  const httpPort = firstHttpPort(pod.ports);
  const runtime = extras?.runtime ?? undefined;
  const gpus = runtime?.gpus ?? [];
  const gpuUtil = avg(gpus.map((g) => g.gpuUtilPercent));
  const gpuMem = avg(gpus.map((g) => g.memoryUtilPercent));
  const maintenance =
    machine?.maintenanceStart && machine.maintenanceEnd
      ? `${machine.maintenanceStart} to ${machine.maintenanceEnd}${machine.maintenanceNote ? `: ${machine.maintenanceNote}` : ""}`
      : "";
  const fields: Fields = {
    name: pod.name ?? "",
    status,
    region,
    location: machine?.location ?? "",
    cloudType: secure === undefined ? "" : secure ? "Secure Cloud" : "Community Cloud",
    computeType: gpuCount > 0 ? "GPU" : "CPU",
    gpuType: pod.gpu?.displayName || machine?.gpuDisplayName || machine?.gpuType?.displayName || "",
    gpuTypeId: pod.gpu?.id || machine?.gpuTypeId || "",
    gpuCount,
    cpuFlavorId: pod.cpuFlavorId ?? "",
    vcpus: pod.vcpuCount ?? 0,
    memoryGb: pod.memoryInGb ?? 0,
    interruptible: pod.interruptible ?? false,
    imageName: pod.image || pod.imageName || "",
    containerDiskGb: pod.containerDiskInGb ?? 0,
    volumeGb: pod.volumeInGb ?? 0,
    volumeMountPath: pod.volumeMountPath ?? "",
    ports: joinList(pod.ports),
    locked: pod.locked ?? false,
    envKeys: Object.keys(pod.env ?? {})
      .sort()
      .join(", "),
    costPerHr: pod.costPerHr ?? 0,
    adjustedCostPerHr: pod.adjustedCostPerHr ?? pod.costPerHr ?? 0,
    templateId: pod.templateId ?? "",
    networkVolumeId: pod.networkVolumeId || pod.networkVolume?.id || "",
    containerRegistryAuthId: pod.containerRegistryAuthId ?? "",
    endpointId: pod.endpointId ?? "",
    sshUser,
    machineId: pod.machineId ?? "",
    maintenance,
    lastStatusChange: pod.lastStatusChange ?? "",
    lastStartedAt: pod.lastStartedAt ?? "",
  };
  if (gpuUtil !== undefined) fields["gpuUtilPercent"] = gpuUtil;
  if (gpuMem !== undefined) fields["gpuMemoryUtilPercent"] = gpuMem;
  if (typeof runtime?.container?.cpuPercent === "number") {
    fields["cpuPercent"] = runtime.container.cpuPercent;
  }
  if (typeof runtime?.container?.memoryPercent === "number") {
    fields["memoryPercent"] = runtime.container.memoryPercent;
  }
  if (typeof runtime?.uptimeInSeconds === "number") {
    fields["uptimeSeconds"] = runtime.uptimeInSeconds;
  }
  return makeInstance({
    accountId,
    typeId: "pod",
    externalId: pod.id,
    displayName: pod.name || pod.id,
    fields,
    outputs: {
      publicIp: pod.publicIp ?? "",
      sshCommand: sshUser ? `ssh ${sshUser}@${SSH_PROXY_HOST}` : "",
      directSshCommand: pod.publicIp && sshPort ? `ssh root@${pod.publicIp} -p ${sshPort}` : "",
      sshProxyHost: sshUser ? SSH_PROXY_HOST : "",
      httpProxyUrl: httpPort ? `https://${pod.id}-${httpPort}.proxy.runpod.net` : "",
    },
    ...(extras?.createdAt ? { createdAt: extras.createdAt } : {}),
  });
}

export function endpointUrls(id: string): Record<string, string> {
  const base = `https://api.runpod.ai/v2/${id}`;
  return {
    runUrl: `${base}/run`,
    runSyncUrl: `${base}/runsync`,
    openAiBaseUrl: `${base}/openai/v1`,
    endpointId: id,
  };
}

export function mapEndpoint(
  e: RpEndpoint,
  accountId: string,
  health: RpEndpointHealth | undefined,
): ResourceInstance {
  const fields: Fields = {
    name: e.name ?? "",
    computeType: e.computeType ?? (e.instanceIds?.length ? "CPU" : "GPU"),
    templateId: e.templateId ?? e.template?.id ?? "",
    gpuTypeIds: joinList(e.gpuTypeIds ?? e.instanceIds),
    gpuCount: e.gpuCount ?? 0,
    workersMin: e.workersMin ?? 0,
    workersMax: e.workersMax ?? 0,
    idleTimeout: e.idleTimeout ?? 0,
    scalerType: e.scalerType ?? "",
    scalerValue: e.scalerValue ?? 0,
    executionTimeoutMs: e.executionTimeoutMs ?? 0,
    flashboot: e.flashboot ?? false,
    dataCenters: joinList(e.dataCenterIds),
    region: e.dataCenterIds?.length === 1 ? (e.dataCenterIds[0] ?? "") : "",
    networkVolumeId: e.networkVolumeId || e.networkVolumeIds?.[0] || "",
    version: e.version ?? 0,
    createdAt: e.createdAt ?? "",
  };
  if (health?.jobs) {
    fields["jobsInQueue"] = health.jobs.inQueue ?? 0;
    fields["jobsInProgress"] = health.jobs.inProgress ?? 0;
    fields["jobsCompleted"] = health.jobs.completed ?? 0;
    fields["jobsFailed"] = health.jobs.failed ?? 0;
  }
  if (health?.workers) {
    fields["workersRunning"] = health.workers.running ?? 0;
    fields["workersIdle"] = health.workers.idle ?? 0;
    // Not in the documented example; only shown when Runpod sends them.
    if (typeof health.workers.throttled === "number") {
      fields["workersThrottled"] = health.workers.throttled;
    }
    if (typeof health.workers.unhealthy === "number") {
      fields["workersUnhealthy"] = health.workers.unhealthy;
    }
  }
  return makeInstance({
    accountId,
    typeId: "serverless-endpoint",
    externalId: e.id,
    displayName: e.name || e.id,
    fields,
    outputs: endpointUrls(e.id),
    ...(e.createdAt ? { createdAt: e.createdAt } : {}),
  });
}

export function mapTemplate(t: RpTemplate, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "template",
    externalId: t.id,
    displayName: t.name || t.id,
    fields: {
      name: t.name ?? "",
      imageName: t.imageName ?? "",
      isServerless: t.isServerless ?? false,
      category: t.category ?? "",
      containerDiskGb: t.containerDiskInGb ?? 0,
      volumeGb: t.volumeInGb ?? 0,
      volumeMountPath: t.volumeMountPath ?? "",
      ports: joinList(t.ports),
      startCommand: (t.dockerStartCmd ?? []).join(" "),
      envKeys: Object.keys(t.env ?? {})
        .sort()
        .join(", "),
      containerRegistryAuthId: t.containerRegistryAuthId ?? "",
      isPublic: t.isPublic ?? false,
      readme: t.readme ?? "",
      earned: t.earned ?? 0,
    },
  });
}

export function mapNetworkVolume(
  v: RpNetworkVolume,
  accountId: string,
  users: Map<string, string[]>,
): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "network-volume",
    externalId: v.id,
    displayName: v.name || v.id,
    fields: {
      name: v.name ?? "",
      sizeGb: v.size ?? 0,
      region: v.dataCenterId ?? "",
      // Always written ("" when unused): the orphan rule depends on it.
      attachedTo: joinList(users.get(v.id)),
    },
  });
}

export function mapRegistryAuth(a: RpRegistryAuth, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "container-registry-auth",
    externalId: a.id,
    displayName: a.name || a.id,
    fields: { name: a.name ?? "" },
  });
}

export function mapSshKey(
  key: ParsedSshKey,
  fingerprint: string,
  externalId: string,
  accountId: string,
): ResourceInstance {
  const name = key.comment || `${key.type} ${fingerprint.slice(7, 19)}`;
  return makeInstance({
    accountId,
    typeId: "ssh-key",
    externalId,
    displayName: name,
    fields: {
      name,
      keyType: key.type,
      fingerprint,
      publicKey: key.line,
    },
  });
}

/** Which pods and endpoints mount each network volume. */
export function volumeUsers(pods: RpPod[], endpoints: RpEndpoint[]): Map<string, string[]> {
  const users = new Map<string, string[]>();
  const add = (volumeId: string | undefined, user: string) => {
    if (!volumeId) return;
    const list = users.get(volumeId) ?? [];
    if (!list.includes(user)) list.push(user);
    users.set(volumeId, list);
  };
  for (const p of pods) {
    if (p.desiredStatus === "TERMINATED") continue;
    add(p.networkVolumeId || p.networkVolume?.id, p.id);
  }
  for (const e of endpoints) {
    add(e.networkVolumeId, e.id);
    for (const v of e.networkVolumeIds ?? []) add(v, e.id);
  }
  return users;
}
