import type { ResourceInstance } from "@infrawrench/plugin-base";
import { nodes } from "./api.js";
import { makeInstance } from "./kit.js";
import type {
  RwCustomDomain,
  RwCustomer,
  RwDeployment,
  RwEnvironment,
  RwProject,
  RwServiceDomain,
  RwServiceInstance,
  RwTcpProxy,
  RwVolumeInstance,
  RwWorkspace,
  RwWorkspaceRef,
} from "./types.js";

/** Pure mapping from Railway payloads to host resource instances. */

export interface InstanceContext {
  projectId: string;
  projectName: string;
  environmentName: string;
}

const STOPPED_STATUSES = new Set(["REMOVED", "REMOVING", "SLEEPING"]);

/** running / stopped / none, from the latest deployment. */
export function runState(d: RwDeployment | null | undefined): "running" | "stopped" | "none" {
  if (!d) return "none";
  if (d.deploymentStopped || STOPPED_STATUSES.has(String(d.status))) return "stopped";
  return "running";
}

export function urlOf(domain: string | undefined): string {
  return domain ? `https://${domain}` : "";
}

function metaString(meta: Record<string, unknown> | null | undefined, key: string): string {
  const v = meta?.[key];
  return typeof v === "string" ? v : "";
}

/** `preDeployCommand` is a JSON array of commands; shown and edited as one line. */
export function preDeployText(v: unknown): string {
  if (Array.isArray(v)) return v.map(String).join(" && ");
  return typeof v === "string" ? v : "";
}

export function mapWorkspace(
  w: RwWorkspace | RwWorkspaceRef,
  customer: RwCustomer | null,
  accountId: string,
): ResourceInstance {
  const full = w as RwWorkspace;
  return makeInstance({
    accountId,
    typeId: "workspace",
    externalId: w.id,
    displayName: w.name,
    fields: {
      name: w.name,
      ...(full.plan ? { plan: full.plan } : {}),
      ...(full.has2FAEnforcement !== undefined
        ? { has2FAEnforcement: full.has2FAEnforcement }
        : {}),
      ...(full.members ? { memberCount: full.members.length } : {}),
      preferredRegion: full.preferredRegion ?? "",
      ...(customer?.currentUsage !== undefined
        ? { currentUsage: round2(customer.currentUsage) }
        : {}),
      ...(customer?.creditBalance !== undefined
        ? { creditBalance: round2(customer.creditBalance) }
        : {}),
      billingPeriodEnd: customer?.billingPeriod?.end ?? "",
      ...(customer?.usageLimit?.softLimit !== undefined
        ? { softLimit: customer.usageLimit.softLimit }
        : {}),
      ...(typeof customer?.usageLimit?.hardLimit === "number"
        ? { hardLimit: customer.usageLimit.hardLimit }
        : {}),
      ...(customer?.usageLimit ? { isOverLimit: customer.usageLimit.isOverLimit === true } : {}),
      customerId: customer?.id ?? "",
    },
    outputs: { workspaceId: w.id },
    ...(full.createdAt ? { createdAt: full.createdAt } : {}),
  });
}

export function mapProject(
  p: RwProject,
  workspace: RwWorkspaceRef | null,
  accountId: string,
): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "project",
    externalId: p.id,
    displayName: p.name,
    fields: {
      name: p.name,
      description: p.description ?? "",
      ...(p.prDeploys !== undefined ? { prDeploys: p.prDeploys } : {}),
      ...(p.isPublic !== undefined ? { isPublic: p.isPublic } : {}),
      environmentCount: nodes(p.environments).length,
      serviceCount: nodes(p.services).length,
      workspaceId: p.workspaceId ?? workspace?.id ?? "",
      workspaceName: workspace?.name ?? "",
      createdAt: p.createdAt ?? "",
    },
    outputs: { projectId: p.id },
    ...(p.createdAt ? { createdAt: p.createdAt } : {}),
    ...(p.updatedAt ? { updatedAt: p.updatedAt } : {}),
  });
}

export function mapEnvironment(
  e: RwEnvironment,
  p: RwProject,
  accountId: string,
): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "environment",
    externalId: e.id,
    displayName: `${p.name} / ${e.name}`,
    fields: {
      name: e.name,
      isEphemeral: e.isEphemeral === true,
      serviceCount: nodes(e.serviceInstances).length,
      volumeCount: nodes(e.volumeInstances).length,
      projectId: p.id,
      projectName: p.name,
      createdAt: e.createdAt ?? "",
    },
    outputs: { environmentId: e.id },
    parentTypeId: "project",
    parentExternalId: p.id,
    ...(e.createdAt ? { createdAt: e.createdAt } : {}),
    ...(e.updatedAt ? { updatedAt: e.updatedAt } : {}),
  });
}

export function primaryDomain(si: RwServiceInstance): string {
  return si.domains?.customDomains?.[0]?.domain ?? si.domains?.serviceDomains?.[0]?.domain ?? "";
}

export function mapServiceInstance(
  si: RwServiceInstance,
  ctx: InstanceContext,
  accountId: string,
): ResourceInstance {
  const d = si.latestDeployment;
  const domain = primaryDomain(si);
  return makeInstance({
    accountId,
    typeId: "service",
    externalId: `${si.environmentId}/${si.serviceId}`,
    displayName: si.serviceName,
    fields: {
      name: si.serviceName,
      status: d?.status ? d.status.toLowerCase() : "",
      state: runState(d),
      region: si.region ?? "",
      ...(typeof si.numReplicas === "number" ? { numReplicas: si.numReplicas } : {}),
      repo: si.source?.repo ?? "",
      image: si.source?.image ?? "",
      builder: si.builder ?? "",
      buildCommand: si.buildCommand ?? "",
      startCommand: si.startCommand ?? "",
      preDeployCommand: preDeployText(si.preDeployCommand),
      rootDirectory: si.rootDirectory ?? "",
      dockerfilePath: si.dockerfilePath ?? "",
      railwayConfigFile: si.railwayConfigFile ?? "",
      healthcheckPath: si.healthcheckPath ?? "",
      ...(typeof si.healthcheckTimeout === "number"
        ? { healthcheckTimeout: si.healthcheckTimeout }
        : {}),
      cronSchedule: si.cronSchedule ?? "",
      nextCronRunAt: si.nextCronRunAt ?? "",
      ...(typeof si.sleepApplication === "boolean"
        ? { sleepApplication: si.sleepApplication }
        : {}),
      restartPolicyType: si.restartPolicyType ?? "",
      ...(typeof si.restartPolicyMaxRetries === "number"
        ? { restartPolicyMaxRetries: si.restartPolicyMaxRetries }
        : {}),
      url: urlOf(domain),
      latestDeploymentId: d?.id ?? "",
      serviceId: si.serviceId,
      environmentId: si.environmentId,
      environmentName: ctx.environmentName,
      projectId: ctx.projectId,
      projectName: ctx.projectName,
      createdAt: si.createdAt ?? "",
    },
    outputs: { serviceId: si.serviceId, url: urlOf(domain), hostname: domain },
    parentTypeId: "environment",
    parentExternalId: si.environmentId,
    ...(si.createdAt ? { createdAt: si.createdAt } : {}),
    ...(si.updatedAt ? { updatedAt: si.updatedAt } : {}),
  });
}

export function mapDeployment(
  d: RwDeployment,
  ctx: { serviceId: string; serviceName: string; environmentId: string; projectId: string },
  accountId: string,
): ResourceInstance {
  const hash = metaString(d.meta, "commitHash");
  const message = metaString(d.meta, "commitMessage").split("\n")[0] ?? "";
  const image = metaString(d.meta, "image");
  return makeInstance({
    accountId,
    typeId: "deployment",
    externalId: d.id,
    displayName: [hash.slice(0, 7), message].filter(Boolean).join(" ") || image || d.id.slice(0, 8),
    fields: {
      status: (d.status ?? "").toLowerCase(),
      reason: metaString(d.meta, "reason"),
      commitHash: hash,
      commitMessage: message,
      branch: metaString(d.meta, "branch"),
      image,
      url: d.staticUrl ? urlOf(d.staticUrl) : (d.url ?? ""),
      canRollback: d.canRollback === true,
      canRedeploy: d.canRedeploy === true,
      deploymentStopped: d.deploymentStopped === true,
      serviceId: ctx.serviceId,
      serviceName: ctx.serviceName,
      environmentId: ctx.environmentId,
      projectId: ctx.projectId,
      createdAt: d.createdAt ?? "",
    },
    outputs: { deploymentId: d.id },
    parentTypeId: "service",
    parentExternalId: `${ctx.environmentId}/${ctx.serviceId}`,
    ...(d.createdAt ? { createdAt: d.createdAt } : {}),
    ...(d.updatedAt ? { updatedAt: d.updatedAt } : {}),
  });
}

export function mapVariable(
  key: string,
  ctx: { serviceId: string; serviceName: string; environmentId: string; projectId: string },
  accountId: string,
): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "variable",
    externalId: `${ctx.environmentId}/${ctx.serviceId}/${key}`,
    displayName: key,
    fields: { key, ...ctx },
    outputs: { key },
    parentTypeId: "service",
    parentExternalId: `${ctx.environmentId}/${ctx.serviceId}`,
  });
}

export function mapSharedVariable(
  key: string,
  ctx: { environmentId: string; environmentName: string; projectId: string },
  accountId: string,
): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "shared-variable",
    externalId: `${ctx.environmentId}/${key}`,
    displayName: key,
    fields: { key, ...ctx },
    outputs: { key },
    parentTypeId: "environment",
    parentExternalId: ctx.environmentId,
  });
}

export function mapVolume(
  v: RwVolumeInstance,
  ctx: InstanceContext & { serviceName: string },
  accountId: string,
): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "volume",
    externalId: `${v.environmentId}/${v.volumeId}`,
    displayName: v.volume?.name || v.mountPath,
    fields: {
      name: v.volume?.name ?? "",
      mountPath: v.mountPath,
      sizeGb: round2(v.sizeMB / 1000),
      ...(typeof v.currentSizeMB === "number" ? { usedGb: round2(v.currentSizeMB / 1000) } : {}),
      state: (v.state ?? "").toLowerCase(),
      region: v.region ?? "",
      serviceId: v.serviceId ?? "",
      serviceName: ctx.serviceName,
      environmentId: v.environmentId,
      environmentName: ctx.environmentName,
      projectId: ctx.projectId,
      volumeInstanceId: v.id,
      createdAt: v.createdAt ?? "",
    },
    outputs: { volumeId: v.volumeId, mountPath: v.mountPath },
    ...(v.createdAt ? { createdAt: v.createdAt } : {}),
  });
}

function dnsSummary(c: RwCustomDomain): string {
  return (c.status?.dnsRecords ?? [])
    .map((r) =>
      `${r.recordType ?? ""} ${r.fqdn || r.hostlabel || ""} → ${r.requiredValue ?? ""}`.trim(),
    )
    .join("; ");
}

export function mapDomain(
  d: { kind: "railway"; domain: RwServiceDomain } | { kind: "custom"; domain: RwCustomDomain },
  ctx: { serviceId: string; environmentId: string; projectId: string },
  accountId: string,
): ResourceInstance {
  const base = d.domain;
  const custom = d.kind === "custom" ? d.domain : null;
  const certExpiry = (custom?.status?.certificates ?? [])
    .map((c) => c.expiresAt ?? "")
    .filter(Boolean)
    .sort()[0];
  return makeInstance({
    accountId,
    typeId: "domain",
    externalId: `${d.kind}/${base.id}`,
    displayName: base.domain,
    fields: {
      domain: base.domain,
      kind: d.kind,
      ...(typeof base.targetPort === "number" ? { targetPort: base.targetPort } : {}),
      syncStatus: (base.syncStatus ?? "").toLowerCase(),
      ...(custom ? { verified: custom.status?.verified === true } : {}),
      certificateStatus: (custom?.status?.certificateStatus ?? "")
        .replace(/^CERTIFICATE_STATUS_TYPE_/, "")
        .toLowerCase(),
      certificateError: custom?.status?.certificateErrorMessage ?? "",
      certExpiresAt: certExpiry ?? "",
      dnsRecords: custom ? dnsSummary(custom) : "",
      ...ctx,
      createdAt: base.createdAt ?? "",
    },
    outputs: { hostname: base.domain, url: urlOf(base.domain) },
    parentTypeId: "service",
    parentExternalId: `${ctx.environmentId}/${ctx.serviceId}`,
    ...(base.createdAt ? { createdAt: base.createdAt } : {}),
  });
}

export function mapTcpProxy(t: RwTcpProxy, projectId: string, accountId: string): ResourceInstance {
  const endpoint = `${t.domain}:${t.proxyPort}`;
  return makeInstance({
    accountId,
    typeId: "tcp-proxy",
    externalId: t.id,
    displayName: `${endpoint} → ${t.applicationPort}`,
    fields: {
      endpoint,
      domain: t.domain,
      proxyPort: t.proxyPort,
      applicationPort: t.applicationPort,
      syncStatus: (t.syncStatus ?? "").toLowerCase(),
      serviceId: t.serviceId,
      environmentId: t.environmentId,
      projectId,
      createdAt: t.createdAt ?? "",
    },
    outputs: { endpoint, host: t.domain, port: String(t.proxyPort) },
    parentTypeId: "service",
    parentExternalId: `${t.environmentId}/${t.serviceId}`,
    ...(t.createdAt ? { createdAt: t.createdAt } : {}),
  });
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
