import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ONLINE_STATES } from "./resource-types.js";
import type { BApiKey, BEnvironment, BSandbox, BSavedSnapshot, BWebhook } from "./types.js";

/** Pure mapping from boat payloads to host resource instances. */

export const PLUGIN_ID = "boat";

type Fields = ResourceInstance["fields"];

export function makeInstance(opts: {
  accountId: string;
  typeId: string;
  externalId: string;
  displayName: string;
  fields: Fields;
  outputs?: Record<string, string>;
  createdAt?: string | null | undefined;
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

export function externalOf(resourceId: string): string {
  return resourceId.includes(":") ? resourceId.split(":").slice(2).join(":") : resourceId;
}

export function formatLabels(labels: Record<string, string> | undefined): string {
  return Object.entries(labels ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

const LABEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,62}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * `a=1, b=2` (commas or newlines) into a label map. boat allows 20 labels, keys
 * of `[A-Za-z0-9][A-Za-z0-9._/-]{0,62}` and values of up to 256 bytes; a key
 * outside that is an error here rather than a 400 after the form closes.
 */
export function parseLabels(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (text ?? "").split(/[,\n]/)) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    const key = (eq < 0 ? p : p.slice(0, eq)).trim();
    if (!LABEL_KEY.test(key)) throw new Error(`boat plugin: "${key}" is not a valid label key`);
    out[key] = eq < 0 ? "" : p.slice(eq + 1).trim();
  }
  if (Object.keys(out).length > 20) throw new Error("boat plugin: at most 20 labels");
  return out;
}

/**
 * `.env`-style text (`KEY=value` per line, `#` comments, optional `export `)
 * into a map. Only the names are ever read back from boat.
 */
export function parseEnv(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of (text ?? "").split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) throw new Error(`boat plugin: "${line}" is not KEY=value`);
    const key = line.slice(0, eq).trim();
    if (!ENV_KEY.test(key)) throw new Error(`boat plugin: "${key}" is not a valid variable name`);
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/** Variable names in an environment's `.env` text, never the values. */
export function envVarNames(envContents: string | undefined): string[] {
  const names: string[] = [];
  for (const raw of (envContents ?? "").split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const key = (eq < 0 ? line : line.slice(0, eq)).trim();
    if (key && ENV_KEY.test(key) && !names.includes(key)) names.push(key);
  }
  return names;
}

/** `203.0.113.10:22001` into host and port. An IPv6 literal comes bracketed. */
export function splitEndpoint(endpoint: string): { host: string; port: number } | null {
  const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(endpoint.trim());
  if (!m) return null;
  return { host: m[1]!, port: Number(m[2]) };
}

export function sshCommand(ip: string, endpoint: string): string {
  const relay = endpoint ? splitEndpoint(endpoint) : null;
  if (relay) return `ssh -p ${relay.port} user@${relay.host}`;
  if (!ip) return "";
  return `ssh user@${ip.includes(":") ? `[${ip}]` : ip}`;
}

function gb(bytes: number | undefined): number {
  return typeof bytes === "number" ? Math.round((bytes / 1e9) * 100) / 100 : 0;
}

export function mapSandbox(s: BSandbox, accountId: string): ResourceInstance {
  const ip = s.ip ?? "";
  const endpoint = s.sshEndpoint ?? "";
  const ttl = s.ttlSeconds;
  return makeInstance({
    accountId,
    typeId: "sandbox",
    externalId: s.id,
    displayName: s.name || s.id,
    fields: {
      name: s.name ?? "",
      state: s.state ?? "",
      online: ONLINE_STATES.includes(s.state ?? ""),
      size: s.type ?? "",
      vcpus: s.vcpu ?? 0,
      memoryGb: s.memoryGB ?? 0,
      billingMultiplier: s.billingMultiplier ?? 0,
      health: s.health ?? "",
      healthReason: s.healthReason ?? "",
      error: s.error ?? "",
      environment: s.environment ?? "",
      environmentVersion: s.environmentVersion ?? "",
      ttlSeconds: typeof ttl === "number" ? ttl : "",
      autoStopAt: s.archiveAfter ?? "",
      // Only a sandbox that is up can run away with machine time.
      autoStopDisabled: ttl === null && ONLINE_STATES.includes(s.state ?? ""),
      subdomain: s.subdomain ?? "",
      labels: formatLabels(s.labels),
      organization: s.team?.name ?? "",
      access: s.access ?? "",
      visibility: s.visibility ?? "",
      createdBy: s.createdBy ?? "",
      snapshots: s.snapshots ?? false,
      monitoring: s.monitoring ?? false,
      lastSnapshotAt: s.snapshotCompletedAt ?? "",
      setupStatus: s.setupStatus ?? "",
      setupError: s.setupError ?? "",
      monthCost: s.cost ? Math.round(s.cost.dollars * 10000) / 10000 : "",
      stoppedAt: s.stoppedAt ?? "",
      dataExpiredAt: s.dataExpiredAt ?? "",
      createdAt: s.createdAt ?? "",
    },
    outputs: {
      ip,
      sshEndpoint: endpoint,
      sshCommand: sshCommand(ip, endpoint),
      url: s.url ?? "",
      // The desktop URL carries a token: never stored with the inventory,
      // fetched on demand by resolveOutput.
    },
    createdAt: s.createdAt,
  });
}

export function mapSavedSnapshot(s: BSavedSnapshot, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "saved-snapshot",
    externalId: s.name,
    displayName: s.name,
    fields: {
      name: s.name,
      status: s.status ?? "",
      error: s.error ?? "",
      sourceSandboxId: s.sourceSandboxId ?? "",
      size: s.type ?? "",
      sizeGb: gb(s.sizeBytes),
      createdAt: s.createdAt ?? "",
    },
    createdAt: s.createdAt,
  });
}

export function mapEnvironment(e: BEnvironment, accountId: string): ResourceInstance {
  const names = envVarNames(e.envContents);
  return makeInstance({
    accountId,
    typeId: "environment",
    externalId: e.id,
    displayName: e.name || e.id,
    fields: {
      name: e.name ?? "",
      isDefault: e.isDefault ?? false,
      latestVersion: e.latestVersionNumber ?? 0,
      safeForThirdParties: e.safeForThirdParties ?? false,
      passGithub: e.passGithub ?? false,
      passSecrets: e.passSecrets ?? false,
      passSandboxCredentials: e.passSandboxCredentials ?? false,
      passAgentsCredentials: e.passAgentsCredentials ?? false,
      proxyAiCredentials: e.proxyAiCredentials ?? false,
      envVarNames: names.join(", "),
      envVarCount: names.length,
      secretFiles: (e.secretFiles ?? [])
        .map((s) => s.path)
        .filter(Boolean)
        .join(", "),
      repositories: (e.selectedRepositories ?? [])
        .map((r) => r.fullName ?? r.name ?? "")
        .filter(Boolean)
        .join(", "),
    },
  });
}

export function mapWebhook(w: BWebhook, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "webhook",
    externalId: w.id,
    displayName: w.name || w.url || w.id,
    fields: {
      name: w.name ?? "",
      url: w.url ?? "",
      events: (w.events ?? []).join(", "),
      createdAt: w.createdAt ?? "",
      updatedAt: w.updatedAt ?? "",
    },
    createdAt: w.createdAt,
  });
}

function scopeList(scope: "*" | string[] | undefined): string {
  if (scope === undefined) return "";
  return scope === "*" ? "All" : scope.join(", ");
}

export function mapApiKey(k: BApiKey, accountId: string): ResourceInstance {
  const actions = k.scope?.actions ?? [];
  const expiresAt = k.expiresAt ?? k.scope?.expiresAt ?? null;
  return makeInstance({
    accountId,
    typeId: "api-key",
    externalId: k.id,
    displayName: k.name || k.id,
    fields: {
      name: k.name ?? "",
      keyHint: k.keyPrefix ? `${k.keyPrefix}…${k.keyLastFour ?? ""}` : "",
      actions: actions.join(", "),
      // A legacy key has no scope at all and is full access.
      admin: actions.includes("*") || actions.includes("account.admin") || !k.scope,
      sandboxScope: k.sandboxId ?? scopeList(k.scope?.sandboxes),
      expiresAt: expiresAt ?? "",
      neverExpires: !expiresAt,
      expired: k.expired ?? false,
      lastUsedAt: k.lastUsedAt ?? "",
      createdAt: k.createdAt ?? "",
    },
    createdAt: k.createdAt,
  });
}
