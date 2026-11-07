import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { ParsedSshKey } from "./ssh-keys.js";
import type {
  RpEndpoint,
  RpEndpointHealth,
  RpGpuType,
  RpNetworkVolume,
  RpPod,
  RpPodExtras,
  RpRegistryAuth,
  RpTemplate,
  RpTemplateExtras,
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

/** REST v2 reports the pod's actual state. */
export function podStatus(status: string | undefined): string {
  switch (status) {
    case "RUNNING":
      return "running";
    case "PROVISIONING":
    case "STARTING":
      return "starting";
    case "EXITED":
      return "stopped";
    case "ERROR":
      return "error";
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

/**
 * A pod's live numbers. A single `GET` carries them; a list has `runtime` and
 * `ssh.direct` null, so a sync reads the same things from GraphQL's `runtime`.
 */
function podLive(pod: RpPod, extras: RpPodExtras | undefined) {
  const rest = pod.runtime ?? undefined;
  const graphql = extras?.runtime ?? undefined;
  const direct = pod.ssh?.direct ?? undefined;
  const restSsh = rest?.ports?.find((p) => p.private === 22 && p.public != null && p.ip);
  const graphqlSsh = graphql?.ports?.find(
    (p) => p.privatePort === 22 && p.publicPort && p.isIpPublic,
  );
  const restIp = rest?.ports?.find((p) => p.public != null && p.ip)?.ip;
  const graphqlIp = graphql?.ports?.find((p) => p.isIpPublic && p.ip)?.ip;
  const sshIp = restSsh?.ip ?? graphqlSsh?.ip;
  const sshPort = restSsh?.public ?? graphqlSsh?.publicPort;
  return {
    gpuUtil: avg(
      rest?.gpus?.map((g) => g.util) ?? graphql?.gpus?.map((g) => g.gpuUtilPercent) ?? [],
    ),
    gpuMem: avg(
      rest?.gpus?.map((g) => g.memoryUtil) ?? graphql?.gpus?.map((g) => g.memoryUtilPercent) ?? [],
    ),
    cpu: rest?.cpu?.util ?? graphql?.container?.cpuPercent,
    memory: rest?.memory?.util ?? graphql?.container?.memoryPercent,
    uptime: rest?.uptime ?? graphql?.uptimeInSeconds,
    publicIp: direct?.host || restIp || graphqlIp || "",
    directSsh: direct?.command || (sshIp && sshPort ? `ssh root@${sshIp} -p ${sshPort}` : ""),
  };
}

export function mapPod(
  pod: RpPod,
  accountId: string,
  extras: RpPodExtras | undefined,
): ResourceInstance {
  const machine = extras?.machine ?? undefined;
  const persistent = pod.mounts?.persistent;
  const network = pod.mounts?.network ?? [];
  const proxy = pod.ssh?.proxy ?? undefined;
  const gpuCount = pod.gpu?.count ?? 0;
  const sshUser = proxy?.username ?? "";
  const sshHost = proxy?.host ?? SSH_PROXY_HOST;
  const httpPort = firstHttpPort(pod.ports);
  const live = podLive(pod, extras);
  const maintenance =
    machine?.maintenanceStart && machine.maintenanceEnd
      ? `${machine.maintenanceStart} to ${machine.maintenanceEnd}${machine.maintenanceNote ? `: ${machine.maintenanceNote}` : ""}`
      : "";
  const fields: Fields = {
    name: pod.name ?? "",
    status: podStatus(pod.status),
    region: pod.dataCenterId ?? "",
    location: machine?.location ?? "",
    cloudType: !pod.cloud ? "" : pod.cloud === "SECURE" ? "Secure Cloud" : "Community Cloud",
    computeType: pod.gpu ? "GPU" : "CPU",
    gpuType: machine?.gpuDisplayName || pod.gpu?.id || "",
    gpuTypeId: pod.gpu?.id ?? "",
    gpuCount,
    cpuFlavorId: pod.cpu?.id ?? "",
    vcpus: pod.gpu?.vcpuCount ?? pod.cpu?.vcpuCount ?? 0,
    memoryGb: pod.gpu?.memory ?? pod.cpu?.memory ?? 0,
    imageName: pod.image ?? "",
    containerDiskGb: pod.disk ?? 0,
    volumeGb: persistent?.size ?? 0,
    volumeMountPath: persistent?.path ?? network[0]?.path ?? "",
    ports: joinList(pod.ports),
    locked: pod.locked ?? false,
    envKeys: Object.keys(pod.env ?? {})
      .sort()
      .join(", "),
    costPerHr: pod.cost ?? 0,
    adjustedCostPerHr: extras?.adjustedCostPerHr ?? pod.cost ?? 0,
    templateId: pod.template ?? "",
    networkVolumeId: network[0]?.volumeId ?? "",
    additionalNetworkVolumes: joinList(network.slice(1).map((m) => m.volumeId)),
    containerRegistryAuthId: pod.registry ?? "",
    sshUser,
    maintenance,
    lastStatusChange: extras?.lastStatusChange ?? "",
    lastStartedAt: pod.startedAt ?? "",
  };
  if (live.gpuUtil !== undefined) fields["gpuUtilPercent"] = live.gpuUtil;
  if (live.gpuMem !== undefined) fields["gpuMemoryUtilPercent"] = live.gpuMem;
  if (typeof live.cpu === "number") fields["cpuPercent"] = live.cpu;
  if (typeof live.memory === "number") fields["memoryPercent"] = live.memory;
  if (typeof live.uptime === "number") fields["uptimeSeconds"] = live.uptime;
  return makeInstance({
    accountId,
    typeId: "pod",
    externalId: pod.id,
    displayName: pod.name || pod.id,
    fields,
    outputs: {
      publicIp: live.publicIp,
      sshCommand: proxy?.command || (sshUser ? `ssh ${sshUser}@${sshHost}` : ""),
      directSshCommand: live.directSsh,
      sshProxyHost: sshUser ? sshHost : "",
      httpProxyUrl: httpPort ? `https://${pod.id}-${httpPort}.proxy.runpod.net` : "",
    },
    ...(pod.createdAt ? { createdAt: pod.createdAt } : {}),
  });
}

/** Queue endpoints take jobs on the Serverless host; load balancing ones have their own host. */
export function endpointUrls(
  e: Pick<RpEndpoint, "id" | "type" | "requestUrls">,
): Record<string, string> {
  const reported = e.requestUrls;
  if (e.type === "LOAD_BALANCER") {
    return {
      loadBalancerUrl:
        reported && "base" in reported ? reported.base : `https://${e.id}.api.runpod.ai`,
      endpointId: e.id,
    };
  }
  const base = `https://api.runpod.ai/v2/${e.id}`;
  return {
    runUrl: reported && "run" in reported ? reported.run : `${base}/run`,
    runSyncUrl: reported && "runSync" in reported ? reported.runSync : `${base}/runsync`,
    openAiBaseUrl: `${base}/openai/v1`,
    endpointId: e.id,
  };
}

/** The GPU types a pool selection comes to, which is what the price lists are keyed by. */
function typesInPools(
  gpu: RpEndpoint["gpu"],
  catalog: readonly RpGpuType[] | undefined,
): Array<string> {
  const pools = gpu?.pools ?? [];
  const excluded = new Set((gpu?.excludedTypes ?? []).map((t) => t.trim()));
  return (catalog ?? [])
    .filter((t) => t.pool && pools.includes(t.pool) && !excluded.has(t.id))
    .map((t) => t.id);
}

export function mapEndpoint(
  e: RpEndpoint,
  accountId: string,
  health: RpEndpointHealth | undefined,
  gpuCatalog?: readonly RpGpuType[],
): ResourceInstance {
  const scaling = e.scaling;
  const fields: Fields = {
    name: e.name ?? "",
    endpointType: e.type ?? "",
    computeType: e.cpu?.length ? "CPU" : "GPU",
    imageName: e.image ?? "",
    gpuPools: joinList(e.gpu?.pools),
    gpuTypeIds: joinList(typesInPools(e.gpu, gpuCatalog)),
    gpuCount: e.gpu?.count ?? 0,
    cpuConfigs: joinList(e.cpu?.map((c) => `${c.id}:${c.vcpuCount}`)),
    workersMin: e.workers?.min ?? 0,
    workersMax: e.workers?.max ?? 0,
    idleTimeout: e.workers?.idleTimeout ?? 0,
    scalerType: scaling?.type ?? "",
    scalerValue: scalingValue(scaling),
    executionTimeoutMs: e.timeout ?? 0,
    flashboot: e.flashboot ?? "OFF",
    dataCenters: joinList(e.dataCenterIds),
    region: e.dataCenterIds?.length === 1 ? (e.dataCenterIds[0] ?? "") : "",
    networkVolumeId: e.mounts?.network?.[0]?.volumeId || e.networkVolumes?.[0] || "",
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
    outputs: endpointUrls(e),
    ...(e.createdAt ? { createdAt: e.createdAt } : {}),
  });
}

/** The threshold of either scaler. */
export function scalingValue(scaling: RpEndpoint["scaling"] | undefined): number {
  if (!scaling) return 0;
  return scaling.type === "QUEUE_DELAY" ? scaling.queueDelay : scaling.requestCount;
}

/**
 * What the start command field shows. `args` is the stored form, so anything set
 * elsewhere round-trips exactly, including its JSON shape; only the `bash -c` this
 * plugin writes for a shell command reads back as the command that was typed.
 */
export function startCommandOf(t: Pick<RpTemplate, "args" | "cmd" | "entrypoint">): string {
  const [shell, flag, command] = t.cmd ?? [];
  if (!t.entrypoint?.length && t.cmd?.length === 3 && shell === "bash" && flag === "-c") {
    return command ?? "";
  }
  return t.args ?? "";
}

export function mapTemplate(
  t: RpTemplate,
  accountId: string,
  extras?: RpTemplateExtras,
): ResourceInstance {
  const persistent = t.mounts?.persistent;
  return makeInstance({
    accountId,
    typeId: "template",
    externalId: t.id,
    displayName: t.name || t.id,
    fields: {
      name: t.name ?? "",
      imageName: t.image ?? "",
      isServerless: t.serverless ?? false,
      category: t.category ?? "",
      containerDiskGb: t.disk ?? 0,
      volumeGb: persistent?.size ?? 0,
      volumeMountPath: persistent?.path ?? "",
      ports: joinList(t.ports),
      startCommand: startCommandOf(t),
      envKeys: Object.keys(t.env ?? {})
        .sort()
        .join(", "),
      containerRegistryAuthId: t.registry ?? "",
      isPublic: t.public ?? false,
      readme: extras?.readme ?? "",
      earned: extras?.earned ?? 0,
    },
  });
}

/** `users` is undefined when the mounts could not be read, which is not the same as none. */
export function mapNetworkVolume(
  v: RpNetworkVolume,
  accountId: string,
  users: Map<string, string[]> | undefined,
): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "network-volume",
    externalId: v.id,
    displayName: v.name || v.id,
    fields: {
      name: v.name ?? "",
      sizeGb: v.size ?? 0,
      region: v.dataCenter ?? "",
      storageType: v.type ?? "",
      // Written whenever it is known ("" when unused): the orphan rule fires on "".
      ...(users ? { attachedTo: joinList(users.get(v.id)) } : {}),
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
    if (p.status === "TERMINATED") continue;
    for (const m of p.mounts?.network ?? []) add(m.volumeId, p.id);
  }
  for (const e of endpoints) {
    for (const m of e.mounts?.network ?? []) add(m.volumeId, e.id);
    for (const v of e.networkVolumes ?? []) add(v, e.id);
  }
  return users;
}
