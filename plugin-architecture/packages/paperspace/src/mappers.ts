import type { ResourceInstance } from "@infrawrench/plugin-base";
import type {
  PDeployment,
  PMachine,
  PNetwork,
  POsTemplate,
  PProject,
  PPublicIp,
  PRegistry,
  PSharedDrive,
  PSnapshot,
  PStartupScript,
} from "./types.js";

/** Pure mapping from Paperspace payloads to host resource instances. */

export const PLUGIN_ID = "paperspace";

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

const GB = 1024 ** 3;
const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

/** Paperspace reports RAM and storage in bytes. */
export function bytesToGb(bytes: number | null | undefined): number {
  return typeof bytes === "number" && bytes > 0 ? round(bytes / GB, 1) : 0;
}

const created = (dt: string | undefined) => (dt ? { createdAt: dt } : {});

export function mapProject(p: PProject, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "project",
    externalId: p.id,
    displayName: p.name || p.id,
    fields: { name: p.name ?? "", repoName: p.repoName ?? "", createdAt: p.dtCreated ?? "" },
    ...created(p.dtCreated),
  });
}

export function mapMachine(m: PMachine, accountId: string): ResourceInstance {
  const gpu = (m.accelerators ?? [])[0];
  const ip = m.publicIp ?? "";
  return makeInstance({
    accountId,
    typeId: "machine",
    externalId: m.id,
    displayName: m.name || m.id,
    fields: {
      name: m.name ?? "",
      state: m.state ?? "",
      machineType: m.machineType ?? "",
      region: m.region ?? "",
      os: m.os ?? "",
      gpu: gpu?.name ?? "",
      gpuCount: gpu?.count ?? 0,
      cpus: m.cpus ?? 0,
      ramGb: bytesToGb(m.ram),
      storageTotalGb: bytesToGb(m.storageTotal),
      storageUsedGb: bytesToGb(m.storageUsed),
      usageRate: m.usageRate ?? 0,
      storageRate: m.storageRate ?? 0,
      publicIpType: m.publicIpType ?? "",
      networkId: m.networkId ?? "",
      autoShutdownEnabled: m.autoShutdownEnabled ?? false,
      autoShutdownTimeout: m.autoShutdownTimeout ?? 0,
      autoShutdownForce: m.autoShutdownForce ?? false,
      autoSnapshotEnabled: m.autoSnapshotEnabled ?? false,
      autoSnapshotFrequency: m.autoSnapshotFrequency ?? "",
      autoSnapshotSaveCount: m.autoSnapshotSaveCount ?? 0,
      updatesPending: m.updatesPending ?? false,
      reservation: m.reservation?.isActive ? (m.reservation.name ?? m.reservation.id ?? "") : "",
      createdAt: m.dtCreated ?? "",
    },
    outputs: {
      publicIp: ip,
      privateIp: m.privateIp ?? "",
      sshCommand: ip ? `ssh paperspace@${ip}` : "",
    },
    ...created(m.dtCreated),
  });
}

export function mapSharedDrive(d: PSharedDrive, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "shared-drive",
    externalId: d.id,
    displayName: d.name || d.id,
    fields: {
      name: d.name ?? "",
      sizeGb: d.size && d.size > 10_000 ? bytesToGb(d.size) : (d.size ?? 0),
      region: d.region ?? "",
      networkId: d.networkId ?? "",
      createdAt: d.dtCreated ?? "",
    },
    // The SMB password is fetched on demand, never stored.
    outputs: { mountPoint: d.mountPoint ?? "", username: d.username ?? "" },
    ...created(d.dtCreated),
  });
}

export function mapSnapshot(s: PSnapshot, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "snapshot",
    externalId: s.id,
    displayName: s.name || s.id,
    fields: {
      name: s.name ?? "",
      machineId: s.machineId ?? "",
      automatic: s.isAutoSnapshot ?? false,
      createdAt: s.dtCreated ?? "",
    },
    ...created(s.dtCreated),
  });
}

export function mapCustomTemplate(t: POsTemplate, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "custom-template",
    externalId: t.id,
    displayName: t.name || t.id,
    fields: {
      name: t.name ?? "",
      os: t.operatingSystemLabel ?? "",
      region: t.region ?? "",
      defaultSizeGb: t.defaultSizeGb ?? 0,
      machineTypes: (t.availableMachineTypes ?? [])
        .filter((m) => m.isAvailable !== false)
        .map((m) => m.machineTypeLabel)
        .join(", "),
      parentMachineId: t.parentMachineId ?? "",
      createdAt: t.dtCreated ?? "",
    },
    ...created(t.dtCreated),
  });
}

export function mapNetwork(n: PNetwork, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "private-network",
    externalId: n.id,
    displayName: n.name || n.id,
    fields: {
      name: n.name ?? "",
      region: n.region ?? "",
      cidr: n.network ? `${n.network}${n.netmask ? ` / ${n.netmask}` : ""}` : "",
      createdAt: n.dtCreated ?? "",
    },
    ...created(n.dtCreated),
  });
}

export function mapPublicIp(p: PPublicIp, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "public-ip",
    externalId: p.ip,
    displayName: p.ip,
    fields: {
      ip: p.ip,
      region: p.region ?? "",
      // Always written ("" when unassigned): the orphan rule depends on it.
      machineId: p.assignedMachineId ?? "",
      createdAt: p.dtCreated ?? "",
    },
    ...created(p.dtCreated),
  });
}

export function mapStartupScript(s: PStartupScript, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "startup-script",
    externalId: s.id,
    displayName: s.name || s.id,
    fields: {
      name: s.name ?? "",
      script: "",
      enabled: s.isEnabled ?? true,
      runOnce: s.isRunOnce ?? false,
      machineIds: (s.assignedMachineIds ?? []).join(", "),
      createdAt: s.dtCreated ?? "",
    },
    ...created(s.dtCreated),
  });
}

export function mapDeployment(d: PDeployment, accountId: string): ResourceInstance {
  const spec = d.latestSpec?.data ?? undefined;
  const endpoint = d.endpoint ?? "";
  return makeInstance({
    accountId,
    typeId: "deployment",
    externalId: d.id,
    displayName: d.name || d.id,
    fields: {
      name: d.name ?? "",
      projectId: d.projectId ?? "",
      image: spec?.image ?? "",
      enabled: spec?.enabled ?? true,
      machineType: spec?.resources?.machineType ?? spec?.resources?.instanceType ?? "",
      replicas: spec?.resources?.replicas ?? 0,
      region: spec?.region ?? "",
      port: spec?.port ?? 0,
      createdAt: d.dtCreated ?? "",
    },
    outputs: {
      endpointUrl: endpoint ? (endpoint.startsWith("http") ? endpoint : `https://${endpoint}`) : "",
    },
    ...(d.projectId ? { parentResourceId: `${accountId}:project:${d.projectId}` } : {}),
    ...created(d.dtCreated),
  });
}

export function mapRegistry(r: PRegistry, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "container-registry",
    externalId: r.id,
    displayName: r.name || r.id,
    fields: {
      name: r.name ?? "",
      kind: r.kind ?? "",
      url: r.url ?? "",
      namespace: r.namespace ?? "",
      username: r.username ?? "",
      createdAt: r.dtCreated ?? "",
    },
    ...created(r.dtCreated),
  });
}
