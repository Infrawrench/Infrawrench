import type { ResourceInstance } from "@infrawrench/plugin-base";
import { envKeysOf, portsOf } from "./docker-env.js";
import type { VEndpoint, VInstance, VSshKey, VTemplate, VVolume, VWorkergroup } from "./types.js";

/** Pure mapping from Vast.ai payloads to host resource instances. */

export const PLUGIN_ID = "vast-ai";

type Fields = ResourceInstance["fields"];

export function makeInstance(opts: {
  accountId: string;
  typeId: string;
  externalId: string;
  displayName: string;
  fields: Fields;
  outputs?: Record<string, string>;
  parentResourceId?: string;
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
    ...(opts.parentResourceId ? { parentResourceId: opts.parentResourceId } : {}),
    createdAt: opts.createdAt || now,
    updatedAt: now,
    lastSyncedAt: now,
  };
}

export function externalOf(resourceId: string): string {
  return resourceId.includes(":") ? resourceId.split(":").slice(2).join(":") : resourceId;
}

/** Unix seconds → ISO, or "" when missing or nonsensical. */
export function isoFromEpoch(sec: number | string | null | undefined): string {
  if (typeof sec === "string") return sec;
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec <= 0) return "";
  const ms = sec * 1000;
  // Vast uses far-future end dates for "no end"; anything past 2100 is that.
  if (ms > Date.UTC(2100, 0, 1)) return "";
  return new Date(ms).toISOString();
}

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

/** Vast's container states folded into the ones the UI and lifecycle use. */
export function normalizeStatus(
  actual: string | null | undefined,
  intended?: string | null,
): string {
  const s = (actual ?? "").toLowerCase();
  if (s === "running") return "running";
  if (s === "loading" || s === "creating" || s === "scheduling") return "loading";
  if (s === "created") return intended === "stopped" ? "stopped" : "created";
  if (s === "stopped" || s === "inactive") return "stopped";
  if (s === "exited") return intended === "stopped" ? "stopped" : "exited";
  if (s === "offline") return "offline";
  if (!s && intended === "stopped") return "stopped";
  return s ? "unknown" : "loading";
}

/** Host port mapped to container port 22, when direct SSH is published. */
function directSshPort(ports: VInstance["ports"]): string {
  if (!ports || Array.isArray(ports)) return "";
  return ports["22/tcp"]?.[0]?.HostPort ?? "";
}

export function mapInstance(i: VInstance, accountId: string): ResourceInstance {
  const sshHost = i.ssh_host ?? "";
  const sshPort = i.ssh_port ? String(i.ssh_port) : "";
  const directPort = directSshPort(i.ports);
  const ip = (i.public_ipaddr ?? "").trim();
  const fields: Fields = {
    label: i.label ?? "",
    status: normalizeStatus(i.actual_status, i.intended_status),
    intendedStatus: i.intended_status ?? "",
    statusMessage: (i.status_msg ?? "").trim(),
    gpuName: i.gpu_name ?? "",
    numGpus: i.num_gpus ?? 0,
    // Vast reports MB and displays GB as MB / 1000.
    gpuRamGb: i.gpu_ram ? round(i.gpu_ram / 1000, 1) : 0,
    vcpus: i.cpu_cores_effective ?? 0,
    ramGb: i.cpu_ram ? round(i.cpu_ram / 1000, 1) : 0,
    diskGb: i.disk_space ? round(i.disk_space, 1) : 0,
    image: i.image_uuid ?? "",
    templateName: i.template_name ?? "",
    templateId: i.template_id ? String(i.template_id) : "",
    pricing: i.is_bid ? "interruptible" : "on-demand",
    pricePerHour: i.dph_total ? round(i.dph_total, 4) : 0,
    bidPrice: i.is_bid && i.dph_base ? round(i.dph_base, 4) : 0,
    minBid: i.min_bid ? round(i.min_bid, 4) : 0,
    location: i.geolocation ?? "",
    machineId: i.machine_id ? String(i.machine_id) : "",
    hostId: i.host_id ? String(i.host_id) : "",
    verification: i.verification ?? "",
    reliability: i.reliability2 ? round(i.reliability2 * 100, 1) : 0,
    cudaMax: i.cuda_max_good ? String(i.cuda_max_good) : "",
    volumeIds: (i.volume_info ?? [])
      .map((v) => (v.volume_id ? String(v.volume_id) : ""))
      .filter(Boolean)
      .join(", "),
    startedAt: isoFromEpoch(i.start_date),
    contractEnd: isoFromEpoch(i.end_date),
  };
  // Utilization is a point-in-time reading; only present while running.
  // gpu_util and disk_usage are percentages (the CLI prints them as-is),
  // cpu_util is a fraction per the spec.
  if (typeof i.gpu_util === "number") fields["gpuUtilPercent"] = round(i.gpu_util, 1);
  if (typeof i.gpu_temp === "number") fields["gpuTempC"] = round(i.gpu_temp, 1);
  if (typeof i.cpu_util === "number") fields["cpuUtilPercent"] = round(i.cpu_util * 100, 1);
  if (typeof i.disk_usage === "number" && i.disk_usage >= 0) {
    fields["diskUsagePercent"] = round(i.disk_usage, 1);
  }
  return makeInstance({
    accountId,
    typeId: "instance",
    externalId: String(i.id),
    displayName: i.label || `${i.num_gpus ?? 1}x ${i.gpu_name ?? "GPU"} #${i.id}`,
    fields,
    outputs: {
      sshCommand: sshHost && sshPort ? `ssh -p ${sshPort} root@${sshHost}` : "",
      directSshCommand: ip && directPort ? `ssh -p ${directPort} root@${ip}` : "",
      publicIp: ip,
      sshHost,
      sshPort,
    },
    ...(fields["startedAt"] ? { createdAt: String(fields["startedAt"]) } : {}),
  });
}

export function mapTemplate(t: VTemplate, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "template",
    externalId: String(t.id),
    displayName: t.name || `Template ${t.id}`,
    fields: {
      name: t.name ?? "",
      image: t.image ?? "",
      tag: t.tag ?? "",
      description: t.desc ?? "",
      diskGb: t.recommended_disk_space ?? 0,
      runtype: t.runtype ?? "",
      sshDirect: t.ssh_direct ?? false,
      private: t.private ?? false,
      envKeys: envKeysOf(t.env).join(", "),
      ports: portsOf(t.env).join(", "),
      hashId: t.hash_id ?? "",
      timesUsed: t.count_created ?? 0,
    },
  });
}

export function mapVolume(v: VVolume, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "volume",
    externalId: String(v.id),
    displayName: v.label || `Volume ${v.id}`,
    fields: {
      name: v.label ?? "",
      sizeGb: v.disk_space ? round(v.disk_space, 1) : 0,
      status: v.status ?? "",
      location: v.geolocation ?? "",
      machineId: v.machine_id ? String(v.machine_id) : "",
      diskName: (v.disk_name ?? "").trim(),
      pricePerHour: v.storage_total_cost ? round(v.storage_total_cost, 5) : 0,
      // Always written ("" when unused): the orphan rule depends on it.
      instanceIds: (v.instances ?? []).map(String).join(", "),
      createdAt: isoFromEpoch(v.start_date),
    },
  });
}

/** First token of a key plus its comment, which is how people recognise their keys. */
export function sshKeyName(key: string, id: number): string {
  const parts = key.trim().split(/\s+/);
  const comment = parts.slice(2).join(" ");
  return comment || `${parts[0] ?? "key"} #${id}`;
}

export function mapSshKey(k: VSshKey, accountId: string): ResourceInstance {
  const key = k.key ?? k.public_key ?? "";
  return makeInstance({
    accountId,
    typeId: "ssh-key",
    externalId: String(k.id),
    displayName: sshKeyName(key, k.id),
    fields: { name: sshKeyName(key, k.id), publicKey: key, createdAt: k.created_at ?? "" },
  });
}

export function mapEndpoint(e: VEndpoint, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "serverless-endpoint",
    externalId: String(e.id),
    displayName: e.endpoint_name || `Endpoint ${e.id}`,
    fields: {
      name: e.endpoint_name ?? "",
      state: e.endpoint_state ?? "",
      maxWorkers: e.max_workers ?? 0,
      coldWorkers: e.cold_workers ?? 0,
      minLoad: e.min_load ?? 0,
      targetUtil: e.target_util ?? 0,
      coldMult: e.cold_mult ?? 0,
      createdAt:
        typeof e.created_at === "number" ? isoFromEpoch(e.created_at) : (e.created_at ?? ""),
    },
  });
}

export function formatSearchQuery(q: unknown): string {
  if (!q) return "";
  if (typeof q === "string") return q;
  if (typeof q !== "object") return String(q);
  return Object.entries(q as Record<string, unknown>)
    .map(([k, v]) => {
      if (v && typeof v === "object") {
        const [op, val] = Object.entries(v as Record<string, unknown>)[0] ?? ["eq", ""];
        const sym: Record<string, string> = {
          eq: "=",
          neq: "!=",
          gt: ">",
          gte: ">=",
          lt: "<",
          lte: "<=",
        };
        return `${k}${sym[op] ?? "="}${Array.isArray(val) ? val.join(",") : String(val)}`;
      }
      return `${k}=${String(v)}`;
    })
    .join(" ");
}

export function mapWorkergroup(w: VWorkergroup, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "workergroup",
    externalId: String(w.id),
    displayName: `${w.endpoint_name || "Workergroup"} #${w.id}`,
    fields: {
      endpointId: w.endpoint_id ? String(w.endpoint_id) : "",
      endpointName: w.endpoint_name ?? "",
      templateHash: w.template_hash ?? "",
      templateId: w.template_id ? String(w.template_id) : "",
      searchQuery: formatSearchQuery(w.search_query),
      gpuRamGb: w.gpu_ram ?? 0,
      testWorkers: w.test_workers ?? 0,
      launchArgs: w.launch_args ?? "",
      createdAt:
        typeof w.created_at === "number" ? isoFromEpoch(w.created_at) : (w.created_at ?? ""),
    },
    ...(w.endpoint_id
      ? { parentResourceId: `${accountId}:serverless-endpoint:${w.endpoint_id}` }
      : {}),
  });
}

export function mapEnvVar(key: string, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "env-var",
    externalId: key,
    displayName: key,
    fields: { key },
  });
}
