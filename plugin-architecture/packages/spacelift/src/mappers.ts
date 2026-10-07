import type { ResourceInstance } from "@infrawrench/plugin-base";

export const PLUGIN_ID = "spacelift";

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

/** Unix seconds to ISO; empty for zero/absent. */
export function unixIso(v: number | null | undefined): string {
  if (!v) return "";
  return new Date(v < 1e12 ? v * 1000 : v).toISOString();
}

export function splitFirst(id: string): [string, string] {
  const i = id.indexOf("/");
  return i < 0 ? [id, ""] : [id.slice(0, i), id.slice(i + 1)];
}

// ---------------------------------------------------------------------------
// GraphQL selections (kept next to the shapes they fill)
// ---------------------------------------------------------------------------

export const STACK_FIELDS = `
  id name description space spaceDetails { id name }
  repository branch projectRoot provider namespace
  administrative autodeploy autoretry labels
  state stateSetAt isDisabled deleting
  lockedBy lockNote lockedAt
  managesStateFile protectFromDeletion runnerImage terraformVersion
  createdAt
  workerPool { id name }
  vendorConfig { __typename }
  trackedCommit { hash message authorName url timestamp }
  blocker { id }
`;

export const RUN_FIELDS = `
  id type state title createdAt triggeredBy branch
  canConfirm canRetry needsApproval driftDetection expired isMostRecent
  commit { hash authorName message }
  delta { addCount changeCount deleteCount resources }
`;

export interface SlStack {
  id: string;
  name: string;
  description?: string | null;
  space: string;
  spaceDetails?: { id?: string; name?: string } | null;
  repository?: string;
  branch?: string;
  projectRoot?: string | null;
  provider?: string;
  namespace?: string;
  administrative?: boolean;
  autodeploy?: boolean;
  autoretry?: boolean;
  labels?: string[];
  state?: string;
  stateSetAt?: number | null;
  isDisabled?: boolean;
  deleting?: boolean;
  lockedBy?: string | null;
  lockNote?: string | null;
  lockedAt?: number | null;
  managesStateFile?: boolean;
  protectFromDeletion?: boolean;
  runnerImage?: string | null;
  terraformVersion?: string | null;
  createdAt?: number;
  workerPool?: { id?: string; name?: string } | null;
  vendorConfig?: { __typename?: string } | null;
  trackedCommit?: {
    hash?: string;
    message?: string;
    authorName?: string;
    url?: string;
    timestamp?: number;
  } | null;
  blocker?: { id?: string } | null;
}

export interface SlRun {
  id: string;
  type?: string;
  state?: string;
  title?: string;
  createdAt?: number;
  triggeredBy?: string | null;
  branch?: string;
  canConfirm?: boolean;
  canRetry?: boolean;
  needsApproval?: boolean;
  driftDetection?: boolean;
  expired?: boolean;
  isMostRecent?: boolean;
  commit?: { hash?: string; authorName?: string; message?: string } | null;
  delta?: {
    addCount?: number;
    changeCount?: number;
    deleteCount?: number;
    resources?: number;
  } | null;
}

export interface SlSpace {
  id: string;
  name: string;
  description?: string;
  parentSpace?: string | null;
  inheritEntities?: boolean;
  labels?: string[];
}

export interface SlContextItem {
  id: string;
  name: string;
  description?: string | null;
  labels?: string[];
  space?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface SlConfig {
  id: string;
  type?: string;
  value?: string | null;
  writeOnly?: boolean;
  description?: string | null;
  checksum?: string;
}

export interface SlPolicy {
  id: string;
  name: string;
  body?: string;
  type?: string;
  description?: string;
  labels?: string[];
  space?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface SlModule {
  id: string;
  name: string;
  namespace?: string;
  repository?: string;
  provider?: string;
  terraformProvider?: string;
  space?: string;
  description?: string | null;
  labels?: string[];
  administrative?: boolean;
  branch?: string;
  createdAt?: number;
}

export interface SlWorkerPool {
  id: string;
  name: string;
  description?: string | null;
  labels?: string[];
  space?: string;
  createdAt?: number;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export function vendorName(typename: string | undefined): string {
  const t = (typename ?? "").replace(/^StackConfigVendor/, "");
  return t === "OpenTofu" ? "OpenTofu" : t;
}

export function mapStack(accountId: string, s: SlStack, url: string): ResourceInstance {
  return instance(
    accountId,
    "stack",
    s.id,
    s.name,
    {
      name: s.name,
      description: s.description ?? "",
      space: s.space,
      spaceName: s.spaceDetails?.name,
      repository: s.repository,
      branch: s.branch,
      projectRoot: s.projectRoot ?? "",
      provider: s.provider,
      namespace: s.namespace,
      vendor: vendorName(s.vendorConfig?.__typename),
      state: s.state,
      stateSetAt: unixIso(s.stateSetAt),
      administrative: s.administrative,
      autodeploy: s.autodeploy,
      autoretry: s.autoretry,
      protectFromDeletion: s.protectFromDeletion,
      disabled: s.isDisabled,
      locked: Boolean(s.lockedBy),
      lockedBy: s.lockedBy ?? undefined,
      lockNote: s.lockNote ?? undefined,
      managesState: s.managesStateFile,
      runnerImage: s.runnerImage ?? "",
      toolVersion: s.terraformVersion ?? undefined,
      labels: (s.labels ?? []).join(", "),
      workerPoolId: s.workerPool?.id,
      workerPool: s.workerPool?.name,
      commit: s.trackedCommit?.hash?.slice(0, 12),
      commitMessage: s.trackedCommit?.message?.split("\n")[0],
      commitAuthor: s.trackedCommit?.authorName,
      blocked: Boolean(s.blocker?.id),
      createdAt: unixIso(s.createdAt),
      stackId: s.id,
    },
    { stackId: s.id, url },
    { typeId: "space", externalId: s.space },
    unixIso(s.createdAt),
  );
}

export function mapRun(
  accountId: string,
  stackId: string,
  stackName: string,
  r: SlRun,
  url: string,
): ResourceInstance {
  const title = (r.title || r.commit?.message || "").split("\n")[0] ?? "";
  return instance(
    accountId,
    "run",
    `${stackId}/${r.id}`,
    `${stackName}: ${title.length > 60 ? `${title.slice(0, 57)}...` : title || r.id}`,
    {
      state: r.state,
      type: r.type,
      title,
      stackName,
      stackId,
      branch: r.branch,
      commit: r.commit?.hash?.slice(0, 12),
      author: r.commit?.authorName,
      triggeredBy: r.triggeredBy ?? undefined,
      drift: r.driftDetection,
      needsApproval: r.needsApproval,
      canConfirm: r.canConfirm,
      canRetry: r.canRetry,
      expired: r.expired,
      toAdd: r.delta?.addCount,
      toChange: r.delta?.changeCount,
      toDelete: r.delta?.deleteCount,
      resources: r.delta?.resources,
      createdAt: unixIso(r.createdAt),
      runId: r.id,
    },
    { runId: r.id, url },
    { typeId: "stack", externalId: stackId },
    unixIso(r.createdAt),
  );
}

export function mapSpace(accountId: string, s: SlSpace): ResourceInstance {
  return instance(
    accountId,
    "space",
    s.id,
    s.name,
    {
      name: s.name,
      description: s.description ?? "",
      parentSpace: s.parentSpace ?? "",
      inheritEntities: s.inheritEntities,
      labels: (s.labels ?? []).join(", "),
      spaceId: s.id,
    },
    { spaceId: s.id },
  );
}

export function mapContext(
  accountId: string,
  c: SlContextItem,
  extra: { variableCount?: number; attachedStacks?: string } = {},
): ResourceInstance {
  return instance(
    accountId,
    "context",
    c.id,
    c.name,
    {
      name: c.name,
      description: c.description ?? "",
      labels: (c.labels ?? []).join(", "),
      space: c.space,
      variableCount: extra.variableCount,
      attachedStacks: extra.attachedStacks,
      updatedAt: unixIso(c.updatedAt),
      contextId: c.id,
    },
    { contextId: c.id },
    undefined,
    unixIso(c.createdAt),
  );
}

export function mapConfig(
  accountId: string,
  contextId: string,
  contextName: string,
  e: SlConfig,
): ResourceInstance {
  const secret = e.writeOnly === true;
  return instance(
    accountId,
    "context-variable",
    `${contextId}/${e.id}`,
    e.id,
    {
      name: e.id,
      type: e.type === "FILE_MOUNT" ? "file" : "env",
      value: secret ? undefined : (e.value ?? ""),
      writeOnly: secret,
      description: e.description ?? "",
      checksum: e.checksum,
      contextName,
      contextId,
    },
    { name: e.id, ...(secret ? {} : { value: e.value ?? "" }) },
    { typeId: "context", externalId: contextId },
  );
}

export function mapPolicy(accountId: string, p: SlPolicy): ResourceInstance {
  return instance(
    accountId,
    "policy",
    p.id,
    p.name,
    {
      name: p.name,
      type: p.type,
      description: p.description ?? "",
      labels: (p.labels ?? []).join(", "),
      space: p.space,
      lines: p.body ? p.body.split("\n").length : undefined,
      body: p.body,
      updatedAt: unixIso(p.updatedAt),
      policyId: p.id,
    },
    { policyId: p.id },
    undefined,
    unixIso(p.createdAt),
  );
}

export function mapModule(accountId: string, m: SlModule): ResourceInstance {
  return instance(
    accountId,
    "module",
    m.id,
    m.name,
    {
      name: m.name,
      description: m.description ?? "",
      terraformProvider: m.terraformProvider,
      namespace: m.namespace,
      repository: m.repository,
      provider: m.provider,
      branch: m.branch,
      administrative: m.administrative,
      labels: (m.labels ?? []).join(", "),
      space: m.space,
      moduleId: m.id,
    },
    { moduleId: m.id },
    undefined,
    unixIso(m.createdAt),
  );
}

export function mapWorkerPool(
  accountId: string,
  w: SlWorkerPool,
  extra: { workers?: number; busy?: number } = {},
): ResourceInstance {
  return instance(
    accountId,
    "worker-pool",
    w.id,
    w.name,
    {
      name: w.name,
      description: w.description ?? "",
      labels: (w.labels ?? []).join(", "),
      space: w.space,
      workers: extra.workers,
      busyWorkers: extra.busy,
      workerPoolId: w.id,
    },
    { workerPoolId: w.id },
    undefined,
    unixIso(w.createdAt),
  );
}

/** Comma-separated labels to a list. */
export function labelList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}
