import type { ResourceInstance } from "@infrawrench/plugin-base";
import { T } from "./resource-types.js";
import type {
  NfAddon,
  NfAuth,
  NfCluster,
  NfDomain,
  NfJob,
  NfPipeline,
  NfPort,
  NfProject,
  NfSecretGroup,
  NfService,
  NfSubdomain,
  NfVolume,
} from "./types.js";

type FieldValue = string | number | boolean | undefined | null;

/** Build a ResourceInstance, dropping empty field values. */
export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, FieldValue>,
  parent?: { typeId: string; externalId: string },
): ResourceInstance {
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    clean[k] = v;
  }
  const now = new Date().toISOString();
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: "northflank",
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: clean,
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    ...(parent ? { parentResourceId: `${accountId}:${parent.typeId}:${parent.externalId}` } : {}),
    createdAt: typeof fields["createdAt"] === "string" ? fields["createdAt"] : now,
    updatedAt: now,
  };
}

/** `{projectId}/{childId}` composite ids used by every project-scoped type. */
export function projectChildId(projectId: string, childId: string): string {
  return `${projectId}/${childId}`;
}

export function splitProjectChild(externalId: string): { projectId: string; id: string } {
  const idx = externalId.indexOf("/");
  if (idx <= 0) throw new Error(`Northflank plugin: malformed resource id "${externalId}"`);
  return { projectId: externalId.slice(0, idx), id: externalId.slice(idx + 1) };
}

const join = (xs: Array<string | undefined> | undefined) =>
  (xs ?? []).filter((x): x is string => !!x).join(", ");

export function mapAccount(
  accountId: string,
  auth: NfAuth,
  teamId: string | undefined,
): ResourceInstance {
  const name =
    (teamId ? `${auth.entityId ?? "Organisation"} / ${teamId}` : auth.entityId) ?? "Northflank";
  return instance(accountId, T.account, auth.entityId || "account", name, {
    name,
    entityType: auth.entityType,
    entityId: auth.entityId,
    teamId,
    tokenName: auth.name ?? auth.id,
    roleName: auth.role?.name,
    creatorEmail: auth.creatorEmail,
    tokenCreatedAt: auth.createdAt,
    tokenExpiresAt: auth.expiresAt ?? undefined,
  });
}

export function mapProject(accountId: string, p: NfProject): ResourceInstance {
  const id = p.id ?? "";
  return instance(accountId, T.project, id, p.name ?? id, {
    name: p.name,
    description: p.description,
    color: p.color,
    region: p.deployment?.region,
    clusterId: p.cluster?.id,
    clusterName: p.cluster?.name,
    uid: p.uid,
    serviceCount: p.services?.length,
    jobCount: p.jobs?.length,
    addonCount: p.addons?.length,
    createdAt: p.createdAt,
  });
}

/** Whether a service is scaled to zero; Northflank's "pause" sets instances to 0. */
export function serviceState(s: NfService): string {
  if (s.serviceType === "build") return "build";
  const instances = s.deployment?.instances;
  if (instances === 0) return "paused";
  const st = s.status?.deployment?.status;
  if (st === "FAILED") return "failed";
  if (st === "PENDING" || st === "IN_PROGRESS") return "deploying";
  if (st === "COMPLETED" || instances !== undefined) return "running";
  return "";
}

export function publicPorts(ports: NfPort[] | undefined): NfPort[] {
  return (ports ?? []).filter((p) => p.public && p.dns);
}

export function mapService(accountId: string, projectId: string, s: NfService): ResourceInstance {
  const id = s.id ?? "";
  const ports = publicPorts(s.ports);
  return instance(
    accountId,
    T.service,
    projectChildId(projectId, id),
    s.name ?? id,
    {
      name: s.name,
      projectId,
      serviceType: s.serviceType,
      description: s.description,
      state: serviceState(s),
      deploymentStatus: s.status?.deployment?.status,
      buildStatus: s.status?.build?.status,
      instances: s.deployment?.instances,
      deploymentPlan: s.billing?.deploymentPlan,
      buildPlan: s.billing?.buildPlan,
      image: s.deployment?.external?.imagePath ?? s.deployment?.imageUrl,
      repository: s.vcsData?.projectUrl,
      branch: s.vcsData?.projectBranch ?? s.deployment?.internal?.branch,
      buildServiceId: s.deployment?.internal?.id,
      publicUrls: ports.map((p) => `https://${p.dns}`).join(", "),
      customDomains: join(ports.flatMap((p) => (p.domains ?? []).map((d) => d.name))),
      disabledCI: s.disabledCI,
      disabledCD: s.disabledCD,
      tags: join(s.tags),
      createdAt: s.createdAt,
    },
    { typeId: T.project, externalId: projectId },
  );
}

export function mapJob(accountId: string, projectId: string, j: NfJob): ResourceInstance {
  const id = j.id ?? "";
  return instance(
    accountId,
    T.job,
    projectChildId(projectId, id),
    j.name ?? id,
    {
      name: j.name,
      projectId,
      jobType: j.jobType,
      description: j.description,
      schedule: j.settings?.cron?.schedule,
      concurrencyPolicy: j.settings?.cron?.concurrencyPolicy?.toLowerCase(),
      backoffLimit: j.settings?.backoffLimit,
      activeDeadlineSeconds: j.settings?.activeDeadlineSeconds,
      suspended: j.jobType === "cron" ? (j.suspended ?? false) : undefined,
      deploymentPlan: j.billing?.deploymentPlan,
      image: j.deployment?.external?.imagePath,
      repository: j.vcsData?.projectUrl,
      branch: j.vcsData?.projectBranch ?? j.deployment?.internal?.branch,
      tags: join(j.tags),
      createdAt: j.createdAt,
    },
    { typeId: T.project, externalId: projectId },
  );
}

export function mapAddon(accountId: string, projectId: string, a: NfAddon): ResourceInstance {
  const id = a.id ?? "";
  const cfg = a.spec?.config;
  return instance(
    accountId,
    T.addon,
    projectChildId(projectId, id),
    a.name ?? id,
    {
      name: a.name,
      projectId,
      addonType: a.spec?.type,
      description: a.description,
      status: a.status,
      version: cfg?.versionTag,
      lifecycleStatus: cfg?.lifecycleStatus,
      deploymentPlan: cfg?.deployment?.planId,
      replicas: cfg?.deployment?.replicas,
      storageMb: cfg?.deployment?.storageSize,
      storageClass: cfg?.deployment?.storageClass,
      region: cfg?.deployment?.region,
      tlsEnabled: cfg?.networking?.tlsEnabled,
      externalAccessEnabled: cfg?.networking?.externalAccessEnabled,
      tags: join(a.tags),
      createdAt: a.createdAt,
    },
    { typeId: T.project, externalId: projectId },
  );
}

export function mapSecretGroup(
  accountId: string,
  projectId: string,
  s: NfSecretGroup,
): ResourceInstance {
  const id = s.id ?? "";
  const keys = s.secrets?.variables ? Object.keys(s.secrets.variables).sort() : undefined;
  return instance(
    accountId,
    T.secretGroup,
    projectChildId(projectId, id),
    s.name ?? id,
    {
      name: s.name,
      projectId,
      description: s.description,
      secretType: s.secretType,
      type: s.type,
      priority: s.priority,
      restricted: s.restrictions?.restricted,
      keys: keys?.join(", "),
      updatedAt: s.updatedAt,
      createdAt: s.createdAt,
    },
    { typeId: T.project, externalId: projectId },
  );
}

export function mapVolume(accountId: string, projectId: string, v: NfVolume): ResourceInstance {
  const id = v.id ?? "";
  return instance(
    accountId,
    T.volume,
    projectChildId(projectId, id),
    v.name ?? id,
    {
      name: v.name,
      projectId,
      storageSizeMb: v.spec?.storageSize,
      storageClass: v.spec?.storageClassName,
      accessMode: v.spec?.accessMode,
      status: v.status,
      attachedTo: join((v.attachedObjects ?? []).map((o) => o.id)),
      createdAt: v.createdAt,
    },
    { typeId: T.project, externalId: projectId },
  );
}

export function mapPipeline(accountId: string, projectId: string, p: NfPipeline): ResourceInstance {
  const id = p.id ?? "";
  const stages = [...new Set((p.nfObjects ?? []).map((o) => o.stage).filter(Boolean))];
  return instance(
    accountId,
    T.pipeline,
    projectChildId(projectId, id),
    p.name ?? id,
    {
      name: p.name,
      projectId,
      description: p.description,
      stages: stages.join(", "),
      resourceCount: p.nfObjects?.length,
      updatedAt: p.updatedAt,
      createdAt: p.createdAt,
    },
    { typeId: T.project, externalId: projectId },
  );
}

export function mapDomain(accountId: string, d: NfDomain): ResourceInstance {
  const name = d.name ?? "";
  return instance(accountId, T.domain, name, name, {
    name,
    status: d.status,
    verifyHostname: d.hostname,
    verifyToken: d.token,
    redirectMode: d.redirect?.mode,
    subdomainCount: d.subdomains?.length,
    certificateExpiry: d.certificates?.status?.expiryDate,
  });
}

export function mapSubdomain(accountId: string, domain: string, s: NfSubdomain): ResourceInstance {
  const name = s.name ?? "";
  return instance(
    accountId,
    T.subdomain,
    `${domain}/${name}`,
    s.fullName ?? name,
    {
      name,
      fullName: s.fullName,
      domain,
      recordType: s.recordType,
      content: s.content,
      verified: s.verified,
      routingMode: s.routingMode,
      cdnEnabled: s.cdn?.northflank?.enabled,
      certificateExpiry: s.certificate?.expiryDate,
    },
    { typeId: T.domain, externalId: domain },
  );
}

export function mapCluster(accountId: string, c: NfCluster): ResourceInstance {
  const id = c.id ?? "";
  const pools = c.nodePools ?? [];
  return instance(accountId, T.cluster, id, c.name ?? id, {
    name: c.name,
    description: c.description,
    provider: c.provider,
    region: c.region,
    state: c.deletionRequested ? "deleting" : c.status?.state?.state,
    stateReason: c.status?.state?.reason,
    nodePools: pools.length,
    nodeTypes: [...new Set(pools.map((p) => p.nodeType).filter(Boolean))].join(", "),
    configuredNodes: pools.reduce((n, p) => n + (p.nodeCount ?? 0), 0),
    createdAt: c.createdAt,
  });
}

/**
 * Pick the connection details out of an addon's `credentials` response.
 * Key names depend on the addon type (`POSTGRES_URI`, `MYSQL_CONNECTOR_URI`,
 * `REDIS_MASTER_URL`, `EXTERNAL_…` variants once public access is on) and
 * the casing has varied, so matching is case- and underscore-insensitive.
 */
export function addonConnection(
  creds: { secrets?: Record<string, unknown>; envs?: Record<string, unknown> } | undefined,
  preferExternal: boolean,
): {
  connectionString?: string;
  host?: string;
  port?: string;
  username?: string;
  password?: string;
  database?: string;
} {
  const all: Array<[string, string]> = [];
  for (const src of [creds?.envs, creds?.secrets]) {
    for (const [k, v] of Object.entries(src ?? {})) {
      if (typeof v === "string" || typeof v === "number") all.push([k, String(v)]);
    }
  }
  const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
  const find = (pred: (k: string) => boolean): string | undefined => {
    const hits = all.filter(([k]) => pred(norm(k)));
    const external = hits.find(([k]) => norm(k).startsWith("external"));
    const internal = hits.find(([k]) => !norm(k).startsWith("external"));
    return (preferExternal ? (external ?? internal) : (internal ?? external))?.[1];
  };
  const isUri = (k: string) =>
    /(uri|url)$/.test(k) &&
    !/jdbc|connector|command|admin|replica|readonly|reader/.test(k) &&
    !/^(http|console|ui)/.test(k);
  const connectionString = find((k) => isUri(k) && /master|primary/.test(k)) ?? find(isUri);
  const strip = (k: string) => k.replace(/^external/, "");
  return {
    ...(connectionString ? { connectionString } : {}),
    ...pick(
      "host",
      find((k) => strip(k) === "host"),
    ),
    ...pick(
      "port",
      find((k) => strip(k) === "port"),
    ),
    ...pick(
      "username",
      find((k) => strip(k) === "username" || strip(k) === "user"),
    ),
    ...pick(
      "password",
      find((k) => strip(k) === "password"),
    ),
    ...pick(
      "database",
      find((k) => strip(k) === "database" || strip(k) === "databasename"),
    ),
  };
}

function pick<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value ? ({ [key]: value } as Record<K, string>) : {};
}
