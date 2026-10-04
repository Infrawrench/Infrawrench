import type { ResourceInstance } from "@infrawrench/plugin-base";
import type {
  BillingSummary,
  ModalApp,
  ModalDict,
  ModalEnvironment,
  ModalFunctionSummary,
  ModalGpu,
  ModalQueue,
  ModalSecret,
  ModalVolume,
} from "./api.js";

export const PLUGIN_ID = "modal";

/** Modal's own redirect to any object's dashboard page (`modal app dashboard` opens it). */
export const objectUrl = (objectId: string): string =>
  objectId ? `https://modal.com/id/${encodeURIComponent(objectId)}` : "";

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, string | number | boolean | undefined | null>,
  outputs: Record<string, string | undefined> = {},
): ResourceInstance {
  const now = new Date().toISOString();
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== "") clean[k] = v;
  }
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(outputs)) if (v) resolved[k] = v;
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: clean,
    resolvedOutputs: resolved,
    secretStates: [],
    externalId,
    createdAt: now,
    updatedAt: now,
  };
}

const iso = (ms: number | undefined): string | undefined =>
  ms !== undefined ? new Date(ms).toISOString() : undefined;

const cents = (n: number | undefined): number | undefined =>
  n === undefined ? undefined : Math.round(n * 100) / 100;

/** "H100", "2 x A100-80GB", with any fallbacks after the first choice. */
export function describeGpus(gpus: ModalGpu[]): string {
  const one = (g: ModalGpu) => (g.count > 1 ? `${g.count} x ${g.type}` : g.type);
  const [first, ...rest] = gpus;
  if (!first) return "";
  return rest.length > 0 ? `${one(first)} (fallbacks: ${rest.map(one).join(", ")})` : one(first);
}

export function mapWorkspace(
  accountId: string,
  name: string,
  environmentCount: number,
  summary: BillingSummary | undefined,
  url: string,
): ResourceInstance {
  return instance(
    accountId,
    "workspace",
    name || "workspace",
    name || "Modal workspace",
    {
      name,
      environmentCount,
      monthMetered: cents(summary?.metered),
      monthBilled: cents(summary?.billed),
    },
    { name, url },
  );
}

export function mapEnvironment(accountId: string, e: ModalEnvironment): ResourceInstance {
  return instance(
    accountId,
    "environment",
    // The id survives a rename; the name is what the API addresses it by.
    e.id || e.name,
    e.name,
    {
      name: e.name,
      webhookSuffix: e.webhookSuffix,
      maxConcurrentTasks: e.maxConcurrentTasks,
      maxConcurrentGpus: e.maxConcurrentGpus,
      isDefault: e.isDefault,
      currentConcurrentTasks: e.currentConcurrentTasks,
      currentConcurrentGpus: e.currentConcurrentGpus,
      cycleUsage: cents(e.currentCycleUsage),
      spendLimit: e.effectiveSpendLimit > 0 ? cents(e.effectiveSpendLimit) : undefined,
      cycleBudget: cents(e.cycleBudget),
      spendLimitReached: e.spendLimitReached,
      createdAt: iso(e.createdAt),
      environmentId: e.id,
    },
    { name: e.name, environmentId: e.id },
  );
}

export function mapApp(accountId: string, a: ModalApp): ResourceInstance {
  return instance(
    accountId,
    "app",
    a.appId,
    a.name || a.appId,
    {
      name: a.name,
      state: a.state,
      environment: a.environment,
      runningTasks: a.runningTasks,
      description: a.description !== a.name ? a.description : undefined,
      version: a.version,
      createdAt: iso(a.createdAt),
      createdBy: a.createdBy,
      deployedAt: iso(a.deployedAt),
      deployedBy: a.deployedBy,
      stoppedAt: iso(a.stoppedAt),
      stoppedBy: a.stoppedBy,
      appId: a.appId,
    },
    { appId: a.appId, url: objectUrl(a.appId) },
  );
}

export function functionKind(
  s: Pick<ModalFunctionSummary, "isServer" | "tag" | "webFunction">,
): string {
  if (s.isServer) return "Server";
  if (s.tag.endsWith(".*")) return "Class";
  if (s.webFunction) return "Web endpoint";
  return "Function";
}

export function mapFunction(
  accountId: string,
  typeId: "function" | "scheduled-function",
  app: Pick<ModalApp, "appId" | "name" | "environment">,
  s: ModalFunctionSummary,
): ResourceInstance {
  const name = s.tag.endsWith(".*") ? s.tag.slice(0, -2) : s.tag;
  return instance(
    accountId,
    typeId,
    s.functionId,
    `${app.name}.${name}`,
    {
      name,
      app: app.name,
      environment: app.environment,
      ...(typeId === "function" ? { kind: functionKind(s), webEndpoint: s.webFunction } : {}),
      gpu: describeGpus(s.gpus),
      schedule: s.schedule?.description,
      appId: app.appId,
      functionId: s.functionId,
    },
    { functionId: s.functionId, url: objectUrl(s.functionId) },
  );
}

export function mapVolume(accountId: string, v: ModalVolume): ResourceInstance {
  return instance(
    accountId,
    "volume",
    v.volumeId,
    v.name,
    {
      name: v.name,
      environment: v.environment,
      version: v.version,
      createdAt: iso(v.createdAt),
      createdBy: v.createdBy,
      volumeId: v.volumeId,
    },
    { name: v.name, volumeId: v.volumeId },
  );
}

export function mapSecret(accountId: string, s: ModalSecret): ResourceInstance {
  return instance(
    accountId,
    "secret",
    s.secretId,
    s.name,
    {
      name: s.name,
      environment: s.environment,
      keys: s.keys.join(", "),
      keyCount: s.keys.length,
      lastUsedAt: iso(s.lastUsedAt),
      createdAt: iso(s.createdAt),
      createdBy: s.createdBy,
      secretId: s.secretId,
    },
    { name: s.name, secretId: s.secretId },
  );
}

export function mapDict(accountId: string, d: ModalDict): ResourceInstance {
  return instance(
    accountId,
    "dict",
    d.dictId,
    d.name,
    {
      name: d.name,
      environment: d.environment,
      createdAt: iso(d.createdAt),
      createdBy: d.createdBy,
      dictId: d.dictId,
    },
    { name: d.name, dictId: d.dictId },
  );
}

export function mapQueue(accountId: string, q: ModalQueue): ResourceInstance {
  return instance(
    accountId,
    "queue",
    q.queueId,
    q.name,
    {
      name: q.name,
      environment: q.environment,
      partitions: q.partitions,
      totalSize: q.totalSize,
      createdAt: iso(q.createdAt),
      createdBy: q.createdBy,
      queueId: q.queueId,
    },
    { name: q.name, queueId: q.queueId },
  );
}
