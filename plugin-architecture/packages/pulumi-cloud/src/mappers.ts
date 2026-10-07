import type { ResourceInstance } from "@infrawrench/plugin-base";

export const PLUGIN_ID = "pulumi-cloud";

type Fields = Record<string, string | number | boolean>;

export function clean(input: Record<string, unknown>): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else out[k] = JSON.stringify(v);
  }
  return out;
}

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, unknown>,
  outputs: Record<string, string | undefined> = {},
  parent?: { typeId: string; externalId: string },
  createdAt?: string,
): ResourceInstance {
  const now = new Date().toISOString();
  const resolvedOutputs: Record<string, string> = {};
  for (const [k, v] of Object.entries(outputs)) if (v) resolvedOutputs[k] = v;
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: clean(fields),
    resolvedOutputs,
    secretStates: [],
    externalId,
    ...(parent ? { parentResourceId: `${accountId}:${parent.typeId}:${parent.externalId}` } : {}),
    createdAt: createdAt || now,
    updatedAt: now,
  };
}

/** Unix seconds or milliseconds to ISO; empty for zero/absent. */
export function unixIso(v: number | undefined | null): string {
  if (!v) return "";
  return new Date(v < 1e12 ? v * 1000 : v).toISOString();
}

/** Split `a/b/c` into its parts (project and stack names cannot contain `/`). */
export function parts(id: string): string[] {
  return id.split("/");
}

// ---------------------------------------------------------------------------
// API shapes
// ---------------------------------------------------------------------------

export interface PuStackSummary {
  id?: string;
  orgName: string;
  projectName: string;
  stackName: string;
  lastUpdate?: number;
  resourceCount?: number;
}

export interface PuStack {
  id?: string;
  orgName: string;
  projectName: string;
  stackName: string;
  activeUpdate?: string;
  currentOperation?: { kind?: string; author?: string; started?: number } | null;
  tags?: Record<string, string>;
  version?: number;
  config?: { environment?: string; secretsProvider?: string };
}

export interface PuUpdate {
  kind?: string;
  startTime?: number;
  endTime?: number;
  message?: string;
  result?: string;
  version?: number;
  resourceChanges?: Record<string, number>;
  resourceCount?: number;
  environment?: Record<string, string>;
}

export interface PuDeployment {
  id: string;
  version?: number;
  status?: string;
  created?: string;
  modified?: string;
  pulumiOperation?: string;
  projectName?: string;
  stackName?: string;
  initiator?: string;
  requestedBy?: { name?: string; githubLogin?: string };
  jobs?: Array<{
    status?: string;
    started?: string;
    lastUpdated?: string;
    steps?: Array<{ name?: string; status?: string }>;
  }>;
  updates?: Array<{ kind?: string; result?: string; version?: number; message?: string }>;
  paused?: boolean;
}

export interface PuEnvironment {
  id?: string;
  deletedAt?: string | null;
  name: string;
  project?: string;
  organization?: string;
  created?: string;
  modified?: string;
  ownedBy?: { name?: string; githubLogin?: string };
  tags?: Record<string, string>;
  referrerMetadata?: {
    stackReferrers?: number;
    environmentReferrers?: number;
    insightsAccountReferrers?: number;
  };
  settings?: { deletionProtected?: boolean };
}

export interface PuToken {
  id: string;
  name?: string;
  description?: string;
  created?: string;
  createdBy?: string;
  expires?: number;
  lastUsed?: number;
  admin?: boolean;
  type?: string;
}

export interface PuTeam {
  name: string;
  displayName?: string;
  description?: string;
  kind?: string;
  members?: unknown[];
  stacks?: unknown[];
  environments?: unknown[];
  userRole?: string;
}

export interface PuWebhook {
  name?: string;
  displayName: string;
  payloadUrl: string;
  active: boolean;
  format?: string;
  groups?: string[];
  filters?: string[];
  hasSecret?: boolean;
  organizationName?: string;
}

export interface PuPolicyPack {
  name: string;
  displayName?: string;
  versions?: number[];
  versionTags?: string[];
}

export interface PuPolicyGroup {
  name: string;
  isOrgDefault?: boolean;
  mode?: string;
  entityType?: string;
  numStacks?: number;
  numAccounts?: number;
  numEnabledPolicyPacks?: number;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export interface OrgStats {
  memberCount?: number | undefined;
  stackCount?: number | undefined;
  projectCount?: number | undefined;
  rum?: number | undefined;
  resourceHours30d?: number | undefined;
  deploymentMinutes30d?: number | undefined;
  secretHours30d?: number | undefined;
  environmentCount?: number | undefined;
  role?: string | undefined;
}

export function mapOrganization(
  accountId: string,
  org: string,
  url: string,
  s: OrgStats,
): ResourceInstance {
  return instance(
    accountId,
    "organization",
    org,
    org,
    {
      name: org,
      role: s.role,
      memberCount: s.memberCount,
      stackCount: s.stackCount,
      projectCount: s.projectCount,
      environmentCount: s.environmentCount,
      resourcesUnderManagement: s.rum,
      resourceHours30d: s.resourceHours30d,
      deploymentMinutes30d: s.deploymentMinutes30d,
      secretHours30d: s.secretHours30d,
    },
    { name: org, url },
  );
}

export function mapProject(
  accountId: string,
  org: string,
  project: string,
  stacks: PuStackSummary[],
  url: string,
): ResourceInstance {
  const last = Math.max(0, ...stacks.map((x) => x.lastUpdate ?? 0));
  return instance(
    accountId,
    "project",
    project,
    project,
    {
      name: project,
      stackCount: stacks.length,
      resourceCount: stacks.reduce((sum, x) => sum + (x.resourceCount ?? 0), 0),
      lastUpdate: unixIso(last),
      organization: org,
    },
    { name: project, url },
  );
}

export function mapStack(
  accountId: string,
  s: PuStackSummary & Partial<PuStack>,
  url: string,
  extra: {
    driftDetected?: boolean | undefined;
    outputCount?: number | undefined;
    repo?: string | undefined;
  } = {},
): ResourceInstance {
  const key = `${s.projectName}/${s.stackName}`;
  const tags = s.tags ?? {};
  return instance(
    accountId,
    "stack",
    key,
    key,
    {
      name: s.stackName,
      project: s.projectName,
      organization: s.orgName,
      fullyQualifiedName: `${s.orgName}/${s.projectName}/${s.stackName}`,
      resourceCount: s.resourceCount,
      lastUpdate: unixIso(s.lastUpdate),
      version: s.version,
      currentOperation: s.currentOperation?.kind,
      operationAuthor: s.currentOperation?.author,
      description: tags["pulumi:description"],
      runtime: tags["pulumi:runtime"],
      repository:
        tags["vcs:owner"] && tags["vcs:repo"]
          ? `${tags["vcs:owner"]}/${tags["vcs:repo"]}`
          : extra.repo,
      tags: Object.entries(tags)
        .filter(
          ([k]) => !k.startsWith("pulumi:") && !k.startsWith("vcs:") && !k.startsWith("gitHub:"),
        )
        .map(([k, v]) => `${k}=${v}`)
        .join(", "),
      secretsProvider: s.config?.secretsProvider,
      environment: s.config?.environment,
      driftDetected: extra.driftDetected,
      outputCount: extra.outputCount,
      stackId: s.id,
    },
    { name: s.stackName, fullyQualifiedName: `${s.orgName}/${s.projectName}/${s.stackName}`, url },
    { typeId: "project", externalId: s.projectName },
  );
}

/** Output values are any JSON; strings stay strings. */
export function outputText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return "";
  return JSON.stringify(v);
}

export function mapOutput(
  accountId: string,
  project: string,
  stack: string,
  name: string,
  value: unknown,
  secret: boolean,
): ResourceInstance {
  return instance(
    accountId,
    "stack-output",
    `${project}/${stack}/${name}`,
    `${project}/${stack}.${name}`,
    {
      name,
      secret,
      type: Array.isArray(value)
        ? "list"
        : value === null
          ? "null"
          : typeof value === "object" && !secret
            ? "object"
            : typeof value,
      preview: secret ? undefined : outputText(value).slice(0, 500),
      project,
      stack,
    },
    { name, ...(secret ? {} : { value: outputText(value) }) },
    { typeId: "stack", externalId: `${project}/${stack}` },
  );
}

export function deploymentSeconds(d: PuDeployment): number | undefined {
  const job = d.jobs?.[0];
  const start = Date.parse(job?.started ?? d.created ?? "");
  const end = Date.parse(job?.lastUpdated ?? d.modified ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return Math.max(0, Math.round((end - start) / 1000));
}

export function mapDeployment(accountId: string, d: PuDeployment, url: string): ResourceInstance {
  const project = d.projectName ?? "";
  const stack = d.stackName ?? "";
  const final = d.status === "succeeded" || d.status === "failed" || d.status === "skipped";
  const update = d.updates?.[0];
  return instance(
    accountId,
    "deployment",
    `${project}/${stack}/${d.id}`,
    `${project}/${stack} #${d.version ?? "?"} ${d.pulumiOperation ?? ""}`.trim(),
    {
      status: d.status ?? "",
      operation: d.pulumiOperation ?? "",
      version: d.version,
      project,
      stack,
      initiator: d.initiator,
      requestedBy: d.requestedBy?.name || d.requestedBy?.githubLogin,
      updateResult: update?.result,
      updateVersion: update?.version,
      steps: d.jobs?.[0]?.steps?.map((x) => `${x.name}: ${x.status}`).join(", "),
      durationSecs: final ? deploymentSeconds(d) : undefined,
      paused: d.paused,
      created: d.created,
      deploymentId: d.id,
    },
    { deploymentId: d.id, url },
    { typeId: "stack", externalId: `${project}/${stack}` },
    d.created,
  );
}

export function mapEnvironment(
  accountId: string,
  org: string,
  e: PuEnvironment,
  url: string,
): ResourceInstance {
  const project = e.project || "default";
  const refs = e.referrerMetadata;
  return instance(
    accountId,
    "environment",
    `${project}/${e.name}`,
    `${project}/${e.name}`,
    {
      name: e.name,
      project,
      owner: e.ownedBy?.name || e.ownedBy?.githubLogin,
      stackReferrers: refs?.stackReferrers,
      environmentReferrers: refs?.environmentReferrers,
      deletionProtected: e.settings?.deletionProtected,
      tags: Object.entries(e.tags ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(", "),
      modified: e.modified,
      organization: org,
      environmentId: e.id,
    },
    { name: `${project}/${e.name}`, url },
    undefined,
    e.created,
  );
}

export function mapToken(accountId: string, org: string, t: PuToken): ResourceInstance {
  return instance(
    accountId,
    "access-token",
    t.id,
    t.name || t.description || t.id,
    {
      name: t.name,
      description: t.description,
      type: t.type,
      admin: t.admin,
      createdBy: t.createdBy,
      created: t.created,
      lastUsed: unixIso(t.lastUsed),
      expires: unixIso(t.expires),
      organization: org,
      tokenId: t.id,
    },
    { tokenId: t.id },
    undefined,
    t.created,
  );
}

export function mapTeam(accountId: string, org: string, t: PuTeam): ResourceInstance {
  return instance(
    accountId,
    "team",
    t.name,
    t.displayName || t.name,
    {
      name: t.name,
      displayName: t.displayName,
      description: t.description,
      kind: t.kind,
      memberCount: t.members?.length,
      stackCount: t.stacks?.length,
      environmentCount: t.environments?.length,
      organization: org,
    },
    { name: t.name },
  );
}

export function mapWebhook(accountId: string, org: string, w: PuWebhook): ResourceInstance {
  const name = w.name || w.displayName;
  return instance(
    accountId,
    "webhook",
    name,
    w.displayName || name,
    {
      name,
      displayName: w.displayName,
      payloadUrl: w.payloadUrl,
      active: w.active,
      format: w.format || "raw",
      groups: (w.groups ?? []).join(", "),
      filters: (w.filters ?? []).join(", "),
      hasSecret: w.hasSecret,
      organization: org,
    },
    { name },
  );
}

export function mapPolicyPack(accountId: string, org: string, p: PuPolicyPack): ResourceInstance {
  const versions = [...(p.versions ?? [])].sort((a, b) => b - a);
  return instance(
    accountId,
    "policy-pack",
    p.name,
    p.displayName || p.name,
    {
      name: p.name,
      displayName: p.displayName,
      latestVersion: versions[0],
      versionCount: versions.length,
      versionTags: (p.versionTags ?? []).join(", "),
      organization: org,
    },
    { name: p.name },
  );
}

export function mapPolicyGroup(accountId: string, org: string, g: PuPolicyGroup): ResourceInstance {
  return instance(
    accountId,
    "policy-group",
    g.name,
    g.name,
    {
      name: g.name,
      isOrgDefault: g.isOrgDefault,
      mode: g.mode,
      entityType: g.entityType,
      stackCount: g.numStacks,
      accountCount: g.numAccounts,
      policyPackCount: g.numEnabledPolicyPacks,
      organization: org,
    },
    { name: g.name },
  );
}
