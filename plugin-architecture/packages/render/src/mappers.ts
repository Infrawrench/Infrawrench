import type { ResourceInstance } from "@infrawrench/plugin-base";
import { makeInstance } from "./kit.js";
import type {
  RenderBlueprint,
  RenderCustomDomain,
  RenderDeploy,
  RenderDisk,
  RenderEnvGroup,
  RenderEnvironment,
  RenderEnvVar,
  RenderIpAllow,
  RenderJob,
  RenderKeyValue,
  RenderMaintenance,
  RenderOwner,
  RenderPostgres,
  RenderProject,
  RenderService,
} from "./types.js";

/** Pure mapping from Render payloads to host resource instances. */

export function mapWorkspace(o: RenderOwner, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "workspace",
    externalId: o.id,
    displayName: o.name || o.email || o.id,
    fields: {
      name: o.name ?? "",
      email: o.email ?? "",
      ownerType: o.type ?? "",
      ...(o.twoFactorAuthEnabled !== undefined
        ? { twoFactorAuthEnabled: o.twoFactorAuthEnabled }
        : {}),
    },
    outputs: { ownerId: o.id },
  });
}

/** `autoDeployTrigger` is the current field; `autoDeploy: yes|no` the legacy one. */
export function autoDeployMode(s: RenderService): string {
  if (s.autoDeployTrigger) return s.autoDeployTrigger;
  if (s.autoDeploy === "yes") return "commit";
  if (s.autoDeploy === "no") return "off";
  return "";
}

export function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

export function mapService(s: RenderService, accountId: string): ResourceInstance {
  const d = s.serviceDetails ?? {};
  const env = d.envSpecificDetails ?? {};
  const a = d.autoscaling;
  const runtime = d.runtime || d.env || "";
  return makeInstance({
    accountId,
    typeId: "service",
    externalId: s.id,
    displayName: s.name,
    fields: {
      name: s.name,
      serviceType: s.type,
      status: s.suspended === "suspended" ? "suspended" : "active",
      suspenders: (s.suspenders ?? []).join(", "),
      region: d.region ?? "",
      plan: d.plan ?? "",
      runtime,
      repo: s.repo ?? "",
      branch: s.branch ?? "",
      rootDir: s.rootDir ?? "",
      imagePath: s.imagePath ?? "",
      autoDeploy: autoDeployMode(s),
      buildCommand: d.buildCommand ?? env.buildCommand ?? "",
      startCommand: env.startCommand ?? env.dockerCommand ?? "",
      preDeployCommand: d.preDeployCommand ?? env.preDeployCommand ?? "",
      publishPath: d.publishPath ?? "",
      schedule: d.schedule ?? "",
      healthCheckPath: d.healthCheckPath ?? "",
      previews:
        d.previews?.generation ?? (d.pullRequestPreviewsEnabled === "yes" ? "automatic" : ""),
      ...(d.maxShutdownDelaySeconds !== undefined
        ? { maxShutdownDelaySeconds: d.maxShutdownDelaySeconds }
        : {}),
      ...(d.numInstances !== undefined ? { numInstances: d.numInstances } : {}),
      ...(a
        ? {
            autoscalingEnabled: a.enabled,
            autoscalingMin: a.min,
            autoscalingMax: a.max,
            ...(a.criteria?.cpu?.enabled
              ? { autoscalingCpuPercent: a.criteria.cpu.percentage }
              : {}),
            ...(a.criteria?.memory?.enabled
              ? { autoscalingMemoryPercent: a.criteria.memory.percentage }
              : {}),
          }
        : {}),
      ...(d.maintenanceMode ? { maintenanceMode: d.maintenanceMode.enabled } : {}),
      url: d.url ?? "",
      diskId: d.disk?.id ?? "",
      environmentId: s.environmentId ?? "",
      ownerId: s.ownerId,
      lastSuccessfulRunAt: d.lastSuccessfulRunAt ?? "",
      dashboardUrl: s.dashboardUrl ?? "",
      createdAt: s.createdAt ?? "",
      updatedAt: s.updatedAt ?? "",
    },
    outputs: {
      serviceId: s.id,
      url: d.url ?? "",
      hostname: hostOf(d.url),
      sshAddress: d.sshAddress ?? "",
    },
    ...(s.createdAt ? { createdAt: s.createdAt } : {}),
    ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
  });
}

export function mapDeploy(
  d: RenderDeploy,
  service: Pick<RenderService, "id" | "name">,
  accountId: string,
): ResourceInstance {
  const commit = d.commit?.id ? d.commit.id.slice(0, 7) : "";
  const message = (d.commit?.message ?? "").split("\n")[0] ?? "";
  return makeInstance({
    accountId,
    typeId: "deploy",
    externalId: `${service.id}/${d.id}`,
    displayName: [commit, message].filter(Boolean).join(" ") || d.image?.ref || d.id,
    fields: {
      status: d.status ?? "",
      trigger: d.trigger ?? "",
      commitId: d.commit?.id ?? "",
      commitMessage: message,
      imageRef: d.image?.ref ?? "",
      serviceId: service.id,
      serviceName: service.name ?? "",
      startedAt: d.startedAt ?? "",
      finishedAt: d.finishedAt ?? "",
      createdAt: d.createdAt ?? "",
    },
    outputs: { deployId: d.id },
    parentTypeId: "service",
    parentExternalId: service.id,
    ...(d.createdAt ? { createdAt: d.createdAt } : {}),
    ...(d.updatedAt ? { updatedAt: d.updatedAt } : {}),
  });
}

export function mapEnvVar(
  v: RenderEnvVar,
  service: Pick<RenderService, "id" | "name">,
  accountId: string,
): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "env-var",
    externalId: `${service.id}/${v.key}`,
    displayName: v.key,
    fields: { key: v.key, serviceId: service.id, serviceName: service.name ?? "" },
    // The value is an output (resolved on demand, masked), never a stored field.
    outputs: { key: v.key },
    parentTypeId: "service",
    parentExternalId: service.id,
  });
}

export function mapCustomDomain(
  c: RenderCustomDomain,
  service: Pick<RenderService, "id" | "name">,
  accountId: string,
): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "custom-domain",
    externalId: `${service.id}/${c.id}`,
    displayName: c.name,
    fields: {
      name: c.name,
      domainType: c.domainType ?? "",
      verificationStatus: c.verificationStatus ?? "",
      redirectForName: c.redirectForName ?? "",
      publicSuffix: c.publicSuffix ?? "",
      serviceId: service.id,
      serviceName: service.name ?? "",
      createdAt: c.createdAt ?? "",
    },
    outputs: { hostname: c.name },
    parentTypeId: "service",
    parentExternalId: service.id,
    ...(c.createdAt ? { createdAt: c.createdAt } : {}),
  });
}

export function mapJob(
  j: RenderJob,
  service: Pick<RenderService, "id" | "name" | "ownerId">,
  accountId: string,
): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "job",
    externalId: `${service.id}/${j.id}`,
    displayName: j.startCommand.length > 60 ? `${j.startCommand.slice(0, 57)}…` : j.startCommand,
    fields: {
      startCommand: j.startCommand,
      status: j.status ?? "",
      planId: j.planId ?? "",
      serviceId: service.id,
      serviceName: service.name ?? "",
      ownerId: service.ownerId ?? "",
      createdAt: j.createdAt ?? "",
      startedAt: j.startedAt ?? "",
      finishedAt: j.finishedAt ?? "",
    },
    outputs: { jobId: j.id },
    parentTypeId: "service",
    parentExternalId: service.id,
    ...(j.createdAt ? { createdAt: j.createdAt } : {}),
  });
}

export function mapDisk(
  d: RenderDisk,
  serviceNames: Map<string, string>,
  accountId: string,
): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "disk",
    externalId: d.id,
    displayName: d.name,
    fields: {
      name: d.name,
      sizeGB: d.sizeGB,
      mountPath: d.mountPath,
      serviceId: d.serviceId ?? "",
      serviceName: d.serviceId ? (serviceNames.get(d.serviceId) ?? "") : "",
      createdAt: d.createdAt ?? "",
      updatedAt: d.updatedAt ?? "",
    },
    outputs: { diskId: d.id, mountPath: d.mountPath },
    ...(d.createdAt ? { createdAt: d.createdAt } : {}),
    ...(d.updatedAt ? { updatedAt: d.updatedAt } : {}),
  });
}

export function ipAllowFields(list: RenderIpAllow[] | undefined): {
  allowedCidrs: string;
  openToInternet: boolean;
} {
  const cidrs = (list ?? []).map((e) => e.cidrBlock).filter(Boolean);
  return {
    allowedCidrs: cidrs.join(", "),
    openToInternet: cidrs.some((c) => c === "0.0.0.0/0" || c === "::/0"),
  };
}

/** `"1.2.3.4/32, 10.0.0.0/8"` → the API's `ipAllowList`. */
export function parseIpAllowList(raw: string): RenderIpAllow[] {
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((cidr) => ({
      cidrBlock: cidr.includes("/") ? cidr : `${cidr}${cidr.includes(":") ? "/128" : "/32"}`,
      description: "Added from Infrawrench",
    }));
}

export function mapPostgres(p: RenderPostgres, accountId: string): ResourceInstance {
  const maint = p.maintenance?.state === "scheduled" ? (p.maintenance.scheduledAt ?? "") : "";
  return makeInstance({
    accountId,
    typeId: "postgres",
    externalId: p.id,
    displayName: p.name,
    fields: {
      name: p.name,
      status: p.status ?? "",
      plan: p.plan ?? "",
      region: p.region ?? "",
      version: p.version ?? "",
      role: p.role ?? "",
      primaryPostgresId: p.primaryPostgresID ?? "",
      databaseName: p.databaseName ?? "",
      databaseUser: p.databaseUser ?? "",
      ...(p.diskSizeGB !== undefined ? { diskSizeGB: p.diskSizeGB } : {}),
      ...(p.diskAutoscalingEnabled !== undefined
        ? { diskAutoscalingEnabled: p.diskAutoscalingEnabled }
        : {}),
      ...(p.highAvailabilityEnabled !== undefined
        ? { highAvailabilityEnabled: p.highAvailabilityEnabled }
        : {}),
      readReplicaCount: (p.readReplicas ?? []).length,
      ...ipAllowFields(p.ipAllowList),
      suspended: p.suspended === "suspended",
      expiresAt: p.expiresAt ?? "",
      maintenanceScheduledAt: maint,
      environmentId: p.environmentId ?? "",
      ownerId: p.owner?.id ?? "",
      dashboardUrl: p.dashboardUrl ?? "",
      createdAt: p.createdAt ?? "",
    },
    outputs: { databaseName: p.databaseName ?? "", databaseUser: p.databaseUser ?? "" },
    ...(p.createdAt ? { createdAt: p.createdAt } : {}),
    ...(p.updatedAt ? { updatedAt: p.updatedAt } : {}),
  });
}

export function mapKeyValue(k: RenderKeyValue, accountId: string): ResourceInstance {
  const maint = k.maintenance?.state === "scheduled" ? (k.maintenance.scheduledAt ?? "") : "";
  return makeInstance({
    accountId,
    typeId: "key-value",
    externalId: k.id,
    displayName: k.name,
    fields: {
      name: k.name,
      status: k.status ?? "",
      plan: k.plan ?? "",
      region: k.region ?? "",
      version: k.version ?? "",
      maxmemoryPolicy: k.options?.maxmemoryPolicy ?? "",
      persistenceMode: k.options?.persistenceMode ?? "",
      ...ipAllowFields(k.ipAllowList),
      maintenanceScheduledAt: maint,
      environmentId: k.environmentId ?? "",
      ownerId: k.owner?.id ?? "",
      dashboardUrl: k.dashboardUrl ?? "",
      createdAt: k.createdAt ?? "",
    },
    ...(k.createdAt ? { createdAt: k.createdAt } : {}),
    ...(k.updatedAt ? { updatedAt: k.updatedAt } : {}),
  });
}

export function mapEnvGroup(g: RenderEnvGroup, accountId: string): ResourceInstance {
  const links = g.serviceLinks ?? [];
  return makeInstance({
    accountId,
    typeId: "env-group",
    externalId: g.id,
    displayName: g.name,
    fields: {
      name: g.name,
      ...(g.envVars ? { varCount: g.envVars.length } : {}),
      ...(g.secretFiles ? { secretFileCount: g.secretFiles.length } : {}),
      linkedServiceIds: links.map((l) => l.id).join(", "),
      linkedServices: links.map((l) => l.name).join(", "),
      environmentId: g.environmentId ?? "",
      ownerId: g.ownerId,
      createdAt: g.createdAt ?? "",
      updatedAt: g.updatedAt ?? "",
    },
    outputs: { envGroupId: g.id },
    ...(g.createdAt ? { createdAt: g.createdAt } : {}),
    ...(g.updatedAt ? { updatedAt: g.updatedAt } : {}),
  });
}

export function mapEnvGroupVar(
  v: RenderEnvVar,
  group: Pick<RenderEnvGroup, "id" | "name">,
  accountId: string,
): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "env-group-var",
    externalId: `${group.id}/${v.key}`,
    displayName: v.key,
    fields: { key: v.key, envGroupId: group.id, envGroupName: group.name },
    outputs: { key: v.key },
    parentTypeId: "env-group",
    parentExternalId: group.id,
  });
}

export function mapProject(p: RenderProject, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "project",
    externalId: p.id,
    displayName: p.name,
    fields: {
      name: p.name,
      environmentCount: (p.environmentIds ?? []).length,
      ownerId: p.owner?.id ?? "",
      createdAt: p.createdAt ?? "",
      updatedAt: p.updatedAt ?? "",
    },
    outputs: { projectId: p.id },
    ...(p.createdAt ? { createdAt: p.createdAt } : {}),
    ...(p.updatedAt ? { updatedAt: p.updatedAt } : {}),
  });
}

export function mapEnvironment(
  e: RenderEnvironment,
  projectName: string,
  accountId: string,
): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "environment",
    externalId: e.id,
    displayName: projectName ? `${projectName} / ${e.name}` : e.name,
    fields: {
      name: e.name,
      protectedStatus: e.protectedStatus ?? "",
      ...(e.networkIsolationEnabled !== undefined
        ? { networkIsolationEnabled: e.networkIsolationEnabled }
        : {}),
      serviceCount: (e.serviceIds ?? []).length,
      databaseCount: (e.databasesIds ?? []).length,
      keyValueCount: (e.redisIds ?? []).length,
      projectId: e.projectId,
      projectName,
    },
    outputs: { environmentId: e.id },
    parentTypeId: "project",
    parentExternalId: e.projectId,
  });
}

export function mapBlueprint(b: RenderBlueprint, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "blueprint",
    externalId: b.id,
    displayName: b.name,
    fields: {
      name: b.name,
      status: b.status ?? "",
      ...(b.autoSync !== undefined ? { autoSync: b.autoSync } : {}),
      repo: b.repo ?? "",
      branch: b.branch ?? "",
      path: b.path ?? "",
      lastSync: b.lastSync ?? "",
    },
    outputs: { blueprintId: b.id },
  });
}

export function mapMaintenance(
  m: RenderMaintenance,
  resourceNames: Map<string, string>,
  accountId: string,
): ResourceInstance {
  const target = m.resourceId ? (resourceNames.get(m.resourceId) ?? m.resourceId) : "";
  return makeInstance({
    accountId,
    typeId: "maintenance",
    externalId: m.id,
    displayName: [m.type || "Maintenance", target].filter(Boolean).join(" on "),
    fields: {
      type: m.type ?? "",
      state: m.state ?? "",
      scheduledAt: m.scheduledAt ?? "",
      pendingMaintenanceBy: m.pendingMaintenanceBy ?? "",
      resourceId: m.resourceId ?? "",
      resourceName: target,
    },
  });
}
