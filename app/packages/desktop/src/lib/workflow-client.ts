/**
 * Desktop renderer-side WorkflowClient.
 *
 * On desktop the workflow's data lives in the renderer: the local SQLite DB is
 * reached via the generic `db_select` / `db_execute` IPC (see ../db/client) and
 * plugin clients are built here (see ./plugin-client). So CRUD, typings, runs,
 * and metrics are all handled locally. The one exception is the QuickJS/WASM
 * isolate itself: it needs Node's `Buffer` (Chromium doesn't have it), so it
 * runs in the Electron main process and calls back into the host we build here
 * (see ./workflow-runner and electron/workflow-host.ts). Automated cron/git
 * triggers are not supported on desktop (cloud/proxy only).
 */
import {
  buildWorkflowHost,
  detailResourceCapabilities,
  clientSupportsImportYaml,
  createFieldsFromConfig,
  generateInfraDts,
  mergeCapabilities,
  staticResourceCapabilities,
  DEFAULT_PAGE_COOLDOWN_MINUTES,
  DEFAULT_PAGE_KEY,
  type MetricDef,
  type MetricValue,
  type PageResult,
  type PageSpec,
  type PromptSpec,
  type WorkflowCreateFieldInfo,
  type WorkflowPluginInfo,
} from "@infrawrench/workflow-runtime/client";

import { runWorkflowInMain } from "./workflow-runner";
import { requestWorkflowPrompt } from "./workflow-prompt";
import type {
  DebugSession,
  WorkflowClient,
  WorkflowMetricRow,
  WorkflowRunResult,
  WorkflowRunRow,
  WorkflowSaveBody,
  WorkflowSummary,
  WorkflowTrigger,
} from "@infrawrench/ui/workflows";

import { useUIStore } from "@infrawrench/ui";

import { getDb } from "../db/client";
import { getPlugin } from "../plugins/loader";
import { createPluginClient } from "./plugin-client";
import { invoke } from "./invoke";

/** Fired after a local workflow is created/updated/deleted, so the cron runner re-syncs. */
export const WORKFLOWS_CHANGED_EVENT = "iw:workflows-changed";

function notifyWorkflowsChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(WORKFLOWS_CHANGED_EVENT));
}

interface WorkflowRow {
  id: string;
  name: string;
  description: string | null;
  source: string;
  trigger: string;
  metric_defs: string;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
  updated_at: string;
}

interface AccountRow {
  id: string;
  plugin_id: string;
  display_name: string;
}

function safeParse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToSummary(row: WorkflowRow): WorkflowSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    source: row.source,
    trigger: safeParse<WorkflowTrigger>(row.trigger, { kind: "manual" }),
    metricDefs: safeParse<MetricDef[]>(row.metric_defs, []),
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    updatedAt: row.updated_at,
  };
}

async function loadRow(id: string): Promise<WorkflowRow | undefined> {
  const db = await getDb();
  const rows = await db.select<WorkflowRow[]>(
    "SELECT * FROM workflows WHERE id = $1 AND deleted_at IS NULL",
    [id],
  );
  return rows[0];
}

// Cache of distilled create-field schemas (per pluginId:typeId) so re-opening
// the editor doesn't re-hit the provider API on every typings request. Mirrors
// server-core's create-fields-cache for the local desktop host.
const createFieldsCache = new Map<
  string,
  { at: number; value: WorkflowCreateFieldInfo[] | null }
>();
const CREATE_FIELDS_TTL_MS = 10 * 60 * 1000;
const CREATE_CONFIG_TIMEOUT_MS = 8_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("getCreateConfig timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Distilled create fields for a single resource type (cached). Returns null when
 * the plugin can't produce a config (child types, slow/erroring providers).
 */
async function getLocalCreateFields(
  pluginId: string,
  typeId: string,
  getClient: () => Promise<Awaited<ReturnType<typeof createPluginClient>>>,
): Promise<WorkflowCreateFieldInfo[] | null> {
  const key = `${pluginId}:${typeId}`;
  const now = Date.now();
  const hit = createFieldsCache.get(key);
  if (hit && now - hit.at <= CREATE_FIELDS_TTL_MS) return hit.value;
  let value: WorkflowCreateFieldInfo[] | null = null;
  try {
    const client = await getClient();
    if (client.getCreateConfig) {
      value = createFieldsFromConfig(
        await withTimeout(client.getCreateConfig(typeId), CREATE_CONFIG_TIMEOUT_MS),
      );
    }
  } catch {
    value = null;
  }
  createFieldsCache.set(key, { at: now, value });
  return value;
}

/**
 * Best-effort (typings path): merge per-resource-type capability flags onto the
 * plugin entry, record `supportsImportYaml`, and type each createable resource's
 * fields from the plugin's live create config. Mutates `entry` in place.
 */
async function enrichLocalPlugin(entry: WorkflowPluginInfo, firstAccountId: string): Promise<void> {
  let clientPromise: Promise<Awaited<ReturnType<typeof createPluginClient>>> | null = null;
  const getClient = () => (clientPromise ??= createPluginClient(firstAccountId, entry.pluginId));

  try {
    const client = await getClient();
    for (const rt of entry.resourceTypes) {
      const caps = detailResourceCapabilities(client, entry.pluginId, rt.id, firstAccountId);
      rt.capabilities = mergeCapabilities(rt.capabilities, caps);
    }
    entry.supportsImportYaml = clientSupportsImportYaml(client);
  } catch {
    // Leave the static capabilities from the base mapping.
  }

  await Promise.all(
    entry.resourceTypes
      .filter((rt) => rt.supportsCreate)
      .map(async (rt) => {
        const value = await getLocalCreateFields(entry.pluginId, rt.id, getClient);
        if (value && value.length > 0) rt.createFields = value;
      }),
  );
}

/** A value that already looks like an OpenSSH public key — leave it alone. */
const PUBLIC_KEY_RE = /^(ssh-|ecdsa-|sk-ssh-|sk-ecdsa-)/;

/**
 * Names of every SSH key the create-form SSH-key picker would offer, for dts
 * autocomplete: saved app keys + system `~/.ssh` keys + 1Password agent keys,
 * plus cloud keys when signed into Infrawrench Cloud. Each source is best-effort.
 */
async function listLocalSshKeyNames(): Promise<string[]> {
  const names = new Set<string>();
  const add = (rows: { name: string }[] | undefined) => {
    for (const r of rows ?? []) if (r.name) names.add(r.name);
  };

  const orgId = useUIStore.getState().activeCloudOrgId;
  const [appRows, system, onepassword, cloud] = await Promise.all([
    getDb()
      .then((db) => db.select<{ name: string }[]>("SELECT name FROM ssh_keys ORDER BY name ASC"))
      .catch(() => [] as { name: string }[]),
    invoke<{ name: string }[]>("ssh_list_system_keys").catch(() => [] as { name: string }[]),
    invoke<{ name: string }[]>("ssh_list_1password_keys").catch(() => [] as { name: string }[]),
    orgId
      ? invoke<{ name: string }[]>("cloud_ssh_keys_list", { orgId }).catch(
          () => [] as { name: string }[],
        )
      : Promise.resolve([] as { name: string }[]),
  ]);
  add(appRows);
  add(system);
  add(onepassword);
  add(cloud);
  return Array.from(names);
}

/**
 * Resolve a key NAME (or id) the workflow author passed to its OpenSSH public
 * key, searching the same sources the picker offers. Returns null if not found.
 */
async function resolveLocalSshPublicKey(nameOrId: string): Promise<string | null> {
  // Saved app key (by id or name) — derive the public key from the stored private.
  try {
    const db = await getDb();
    const rows = await db.select<{ id: string }[]>(
      "SELECT id FROM ssh_keys WHERE id = $1 OR name = $1 LIMIT 1",
      [nameOrId],
    );
    if (rows[0]) return await invoke<string>("ssh_key_get_public_key", { keyId: rows[0].id });
  } catch {
    /* fall through */
  }
  // 1Password agent — public key is returned directly.
  try {
    const onepw = await invoke<{ name: string; publicKey: string }[]>("ssh_list_1password_keys");
    const match = onepw.find((k) => k.name === nameOrId);
    if (match?.publicKey) return match.publicKey;
  } catch {
    /* fall through */
  }
  // Cloud key (by name or id) — public key lives server-side.
  const orgId = useUIStore.getState().activeCloudOrgId;
  if (orgId) {
    try {
      const cloud = await invoke<{ id: string; name: string; publicKey: string }[]>(
        "cloud_ssh_keys_list",
        { orgId },
      );
      const match = cloud.find((k) => k.name === nameOrId || k.id === nameOrId);
      if (match?.publicKey) return match.publicKey;
    } catch {
      /* fall through */
    }
  }
  // System ~/.ssh key — read the matching .pub file.
  try {
    const pub = await invoke<string>("ssh_read_system_key", { name: `${nameOrId}.pub` });
    if (pub?.trim()) return pub.trim();
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Workflow host `transformCreateFields`: rewrite `ssh-key-picker` field values
 * that name a local Infrawrench key into that key's public key (providers want
 * the raw public key). A value that is already a public key is left untouched.
 */
async function resolveLocalCreateSshKeyFields(
  accountId: string,
  typeId: string,
  fields: Record<string, string>,
): Promise<{ fields: Record<string, string>; sshKeyRef?: string }> {
  const pluginId = await pluginIdForAccount(accountId).catch(() => null);
  if (!pluginId) return { fields };
  const createFields = await getLocalCreateFields(pluginId, typeId, () =>
    createPluginClient(accountId, pluginId),
  );
  const sshFieldKeys = (createFields ?? [])
    .filter((f) => f.kind === "ssh-key-picker")
    .map((f) => f.key);
  if (sshFieldKeys.length === 0) return { fields };
  const out = { ...fields };
  let sshKeyRef: string | undefined;
  for (const key of sshFieldKeys) {
    const value = out[key]?.trim();
    if (!value || PUBLIC_KEY_RE.test(value)) continue;
    const pub = await resolveLocalSshPublicKey(value);
    if (pub) {
      out[key] = pub.trim();
      // Remember the key name so the created resource can ssh() with it.
      if (!sshKeyRef) sshKeyRef = value;
    }
  }
  return { fields: out, ...(sshKeyRef ? { sshKeyRef } : {}) };
}

/**
 * Build the account-tree the isolate's `infra.accounts` is generated from.
 *
 * `enrichCreateFields` (typings path only) fetches each createable type's live
 * create config so `create({...})` is typed; the runtime path (every run) leaves
 * it off to avoid provider API calls on run startup.
 */
async function listLocalPlugins(
  opts: { enrichCreateFields?: boolean } = {},
): Promise<WorkflowPluginInfo[]> {
  const db = await getDb();
  const accounts = await db.select<AccountRow[]>(
    "SELECT id, plugin_id, display_name FROM accounts WHERE deleted_at IS NULL",
  );
  const byPlugin = new Map<string, WorkflowPluginInfo>();
  for (const acc of accounts) {
    let entry = byPlugin.get(acc.plugin_id);
    if (!entry) {
      const lp = await getPlugin(acc.plugin_id);
      if (!lp) continue;
      entry = {
        pluginId: acc.plugin_id,
        displayName: lp.plugin.manifest.displayName,
        accounts: [],
        resourceTypes: lp.plugin.resourceTypes.map((rt) => ({
          id: rt.id,
          displayName: rt.displayName,
          pluralDisplayName: rt.pluralDisplayName,
          outputs: (rt.outputs ?? []).map((o) => ({ key: o.key, label: o.label })),
          supportsCreate: Boolean(rt.supportsCreate),
          supportsUpdate: Boolean(rt.supportsUpdate),
          // supportsDelete defaults to true (only `false` disables deletion).
          supportsDelete: rt.supportsDelete !== false,
          storage: Boolean(rt.supportsStorageBrowser),
          capabilities: staticResourceCapabilities(rt),
        })),
      };
      byPlugin.set(acc.plugin_id, entry);
    }
    entry.accounts.push({ id: acc.id, pluginId: acc.plugin_id, displayName: acc.display_name });
  }

  if (opts.enrichCreateFields) {
    await Promise.all(
      Array.from(byPlugin.values()).map((entry) => {
        const first = entry.accounts[0];
        return first ? enrichLocalPlugin(entry, first.id) : Promise.resolve();
      }),
    );
  }

  return Array.from(byPlugin.values());
}

function metricTypeOf(value: MetricValue): "number" | "string" | "boolean" {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

/** A plugin id → account id helper so the isolate can reach the right client. */
async function pluginIdForAccount(accountId: string): Promise<string> {
  const db = await getDb();
  const rows = await db.select<{ plugin_id: string }[]>(
    "SELECT plugin_id FROM accounts WHERE id = $1",
    [accountId],
  );
  const pluginId = rows[0]?.plugin_id;
  if (!pluginId) throw new Error(`Account ${accountId} not found.`);
  return pluginId;
}

/**
 * Deliver `infra.page(...)` locally as a native OS notification.
 *
 * The cloud fans a page out to Twilio + mobile push; desktop has no recipients
 * to fan out to, so the machine running the workflow is the pager. The per-key
 * cooldown still applies — that is what makes a cron that finds the same
 * problem every tick notify once instead of every tick — and it lives in the
 * local `workflow_pages` table so it survives restarts. Single process, so a
 * read-then-write is enough; the cloud needs a conditional upsert because two
 * poller replicas can race the same workflow.
 */
async function pageFromLocalWorkflow(
  workflowId: string,
  workflowName: string,
  spec: PageSpec,
): Promise<PageResult> {
  const db = await getDb();
  const key = spec.key || DEFAULT_PAGE_KEY;
  const cooldownMs = Math.max(0, spec.cooldownMinutes ?? DEFAULT_PAGE_COOLDOWN_MINUTES) * 60_000;

  const rows = await db.select<{ last_paged_at: string }[]>(
    "SELECT last_paged_at FROM workflow_pages WHERE workflow_id = $1 AND key = $2",
    [workflowId, key],
  );
  const last = rows[0]?.last_paged_at ? Date.parse(rows[0].last_paged_at) : null;
  if (last !== null && Number.isFinite(last) && Date.now() - last < cooldownMs) {
    return {
      delivered: false,
      suppressed: true,
      sms: 0,
      push: 0,
      retryAt: new Date(last + cooldownMs).toISOString(),
    };
  }

  await invoke("show_notification", {
    title: spec.title ?? workflowName,
    body: spec.message,
  });
  const now = new Date().toISOString();
  await db.execute(
    `INSERT INTO workflow_pages (id, workflow_id, key, last_paged_at, last_message)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(workflow_id, key) DO UPDATE SET last_paged_at = excluded.last_paged_at, last_message = excluded.last_message`,
    [crypto.randomUUID(), workflowId, key, now, spec.message],
  );
  return { delivered: true, suppressed: false, sms: 0, push: 0 };
}

/** Drop a key's cooldown so its next page notifies immediately. */
async function clearLocalWorkflowPage(workflowId: string, key: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM workflow_pages WHERE workflow_id = $1 AND key = $2", [
    workflowId,
    key,
  ]);
}

/** Raise an interactive prompt via the renderer modal (window.prompt is a no-op in Electron). */
function askUser(spec: PromptSpec): Promise<MetricValue> {
  return requestWorkflowPrompt(spec);
}

type DesktopSshConfig = {
  sshHost: string;
  sshPort: number;
  sshUser: string;
  privateKey: string;
};

/** Resolve where a resource lives for SSH (host/port/user) — no private key needed. */
async function resolveSshTarget(params: {
  accountId: string;
  typeId: string;
  resourceId: string;
  username?: string;
}): Promise<{ host: string; port: number; username: string; native?: DesktopSshConfig }> {
  const pluginId = await pluginIdForAccount(params.accountId);
  const client = await createPluginClient(params.accountId, pluginId);
  const native = client.getSshConfig?.();
  if (native) {
    return {
      host: native.host,
      port: native.port,
      username: params.username ?? native.username,
      native: {
        sshHost: native.host,
        sshPort: native.port,
        sshUser: params.username ?? native.username,
        privateKey: native.privateKey,
      },
    };
  }
  const lp = await getPlugin(pluginId);
  const sshEndpoint = lp?.plugin.resourceTypes.find((r) => r.id === params.typeId)?.sshEndpoint;
  if (!sshEndpoint) {
    throw new Error(
      `Resource type "${params.typeId}" does not expose an SSH endpoint, and its plugin has no native SSH support.`,
    );
  }
  // The host lives in the resource's resolvedOutputs (e.g. a droplet's ipv4),
  // read live via getResource — NOT resolveOutput, which most plugins don't
  // implement for these keys (DO throws). Falls back to a same-named field.
  const instance = await client.getResource(params.typeId, params.resourceId, params.accountId);
  const host =
    instance.resolvedOutputs?.[sshEndpoint.hostOutputKey] ??
    (instance.fields?.[sshEndpoint.hostOutputKey] as string | undefined);
  if (!host) {
    throw new Error(
      `Could not resolve the SSH host (output "${sshEndpoint.hostOutputKey}") for this resource — is it running yet?`,
    );
  }
  return {
    host: String(host),
    port: 22,
    username: params.username ?? sshEndpoint.defaultUsername ?? "root",
  };
}

/** Resolve a private-key PEM from a local app key (by id or name) or a ~/.ssh file. */
async function resolveSshPrivateKey(sshKey: string): Promise<string> {
  const db = await getDb();
  const rows = await db.select<{ id: string; name: string }[]>(
    "SELECT id, name FROM ssh_keys WHERE id = $1 OR name = $1 LIMIT 1",
    [sshKey],
  );
  if (rows[0]) return invoke<string>("ssh_key_get_private_key", { keyId: rows[0].id });
  // Fall back to a system key file name in ~/.ssh (may prompt for consent).
  return invoke<string>("ssh_read_system_key", { name: sshKey });
}

/** Build a full connect config (host + key) for a workflow `resource.ssh(...)` call. */
async function resolveDesktopSshConfig(params: {
  accountId: string;
  typeId: string;
  resourceId: string;
  sshKeyId?: string;
  username?: string;
}): Promise<DesktopSshConfig> {
  const target = await resolveSshTarget(params);
  if (target.native) return target.native;
  if (!params.sshKeyId) {
    throw new Error(
      'ssh() needs an SSH key to authenticate — pass { sshKey: "<key name or ~/.ssh file>" }.',
    );
  }
  const privateKey = await resolveSshPrivateKey(params.sshKeyId);
  return {
    sshHost: target.host,
    sshPort: target.port,
    sshUser: target.username,
    privateKey,
  };
}

/** SftpConfig-shaped (host/port/username/privateKey) connect config for SFTP. */
async function resolveDesktopSftpConfig(params: {
  accountId: string;
  typeId: string;
  resourceId: string;
  sshKeyId?: string;
  username?: string;
}): Promise<{ host: string; port: number; username: string; privateKey: string }> {
  const c = await resolveDesktopSshConfig(params);
  return { host: c.sshHost, port: c.sshPort, username: c.sshUser, privateKey: c.privateKey };
}

export function createDesktopWorkflowClient(): WorkflowClient {
  return {
    async list() {
      const db = await getDb();
      const rows = await db.select<WorkflowRow[]>(
        "SELECT * FROM workflows WHERE deleted_at IS NULL ORDER BY updated_at DESC",
      );
      return rows.map(rowToSummary);
    },

    async create(body: WorkflowSaveBody) {
      const db = await getDb();
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await db.execute(
        `INSERT INTO workflows (id, name, description, source, trigger, metric_defs, enabled, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          body.name?.trim() || "Untitled workflow",
          body.description ?? null,
          body.source ?? "",
          JSON.stringify(body.trigger ?? { kind: "manual" }),
          JSON.stringify(body.metrics ?? []),
          body.enabled === false ? 0 : 1,
          now,
          now,
        ],
      );
      notifyWorkflowsChanged();
      return rowToSummary((await loadRow(id))!);
    },

    async update(id: string, body: WorkflowSaveBody) {
      const existing = await loadRow(id);
      if (!existing) throw new Error("Workflow not found");
      const db = await getDb();
      const now = new Date().toISOString();
      await db.execute(
        `UPDATE workflows SET name = $1, description = $2, source = $3, trigger = $4, metric_defs = $5, enabled = $6, updated_at = $7
         WHERE id = $8`,
        [
          body.name?.trim() || existing.name,
          body.description ?? existing.description,
          body.source ?? existing.source,
          body.trigger !== undefined ? JSON.stringify(body.trigger) : existing.trigger,
          body.metrics !== undefined ? JSON.stringify(body.metrics) : existing.metric_defs,
          body.enabled === undefined ? existing.enabled : body.enabled ? 1 : 0,
          now,
          id,
        ],
      );
      // Trigger changes invalidate the schedule — let the cron runner recompute it.
      if (body.trigger !== undefined) {
        await db.execute("UPDATE workflows SET next_run_at = NULL WHERE id = $1", [id]);
      }
      notifyWorkflowsChanged();
      return rowToSummary((await loadRow(id))!);
    },

    async remove(id: string) {
      const db = await getDb();
      const now = new Date().toISOString();
      await db.execute("UPDATE workflows SET deleted_at = $1, updated_at = $2 WHERE id = $3", [
        now,
        now,
        id,
      ]);
      notifyWorkflowsChanged();
    },

    async getTypings(id: string) {
      const wf = await loadRow(id);
      // Enrichment + key listing are best-effort — never let them fail the whole
      // typings response (which would drop the editor back to `infra: any`).
      const [plugins, sshKeyNames] = await Promise.all([
        listLocalPlugins({ enrichCreateFields: true }).catch(() => listLocalPlugins()),
        listLocalSshKeyNames().catch(() => [] as string[]),
      ]);
      const trigger = wf
        ? safeParse<WorkflowTrigger>(wf.trigger, { kind: "manual" })
        : { kind: "manual" as const };
      return generateInfraDts({
        plugins,
        metrics: wf ? safeParse<MetricDef[]>(wf.metric_defs, []) : [],
        interactive: trigger.kind === "manual",
        triggerKind: trigger.kind,
        // Local workflows have no cost store (costs are cloud-only), so
        // `infra.costs` types as unavailable rather than failing at run time.
        costs: false,
        sshKeyNames,
      });
    },

    async listRuns(id: string) {
      const db = await getDb();
      const rows = await db.select<Record<string, unknown>[]>(
        "SELECT * FROM workflow_runs WHERE workflow_id = $1 ORDER BY created_at DESC LIMIT 50",
        [id],
      );
      return rows.map((r): WorkflowRunRow => {
        const run: WorkflowRunRow = {
          id: String(r["id"]),
          status: String(r["status"]),
          triggerSource: String(r["trigger_source"]),
          logs: safeParse(r["logs"], []),
          error: safeParse(r["error"], null),
          startedAt: (r["started_at"] as string | null) ?? null,
          finishedAt: (r["finished_at"] as string | null) ?? null,
          durationMs: (r["duration_ms"] as number | null) ?? null,
          createdAt: r["created_at"] as string,
        };
        const output = safeParse<unknown>(r["output"], undefined);
        if (output !== undefined) run.output = output;
        return run;
      });
    },

    async listMetrics(id: string) {
      const db = await getDb();
      const rows = await db.select<
        { key: string; label: string; type: string; unit: string | null; value: string | null }[]
      >(
        "SELECT key, label, type, unit, value FROM workflow_metrics WHERE workflow_id = $1 AND deleted_at IS NULL",
        [id],
      );
      return rows.map((r) => ({
        key: r.key,
        label: r.label,
        type: r.type,
        unit: r.unit,
        value: r.value == null ? null : safeParse(r.value, null),
      }));
    },

    async run(id: string, debug?: DebugSession) {
      return runWorkflowById(id, {
        interactive: true,
        triggerSource: "manual",
        ...(debug ? { debug } : {}),
      });
    },
  };
}

/**
 * Execute a local workflow by id: seed its metrics, record a run, run the
 * source in the main-process sandbox, and persist the outcome. Shared by the
 * panel's manual Run (interactive) and the local cron runner (non-interactive,
 * trigger_source "cron"). Returns the run id + result.
 */
export async function runWorkflowById(
  id: string,
  opts: { interactive: boolean; triggerSource: string; debug?: DebugSession } = {
    interactive: true,
    triggerSource: "manual",
  },
): Promise<{ runId: string; result: WorkflowRunResult }> {
  const wf = await loadRow(id);
  if (!wf) throw new Error("Workflow not found");
  const db = await getDb();

  // Debugger pause loop (renderer-side): host.line(n) highlights the line and
  // blocks at a breakpoint / while stepping until the user resumes/steps/stops.
  const debug = opts.debug;
  let stepping = false;
  let stopRequested = false;
  let stopMain: (() => void) | null = null;
  let pendingResume: (() => void) | null = null;
  let pendingReject: ((e: Error) => void) | null = null;
  const debugLine = debug
    ? async (n: number): Promise<void> => {
        // Unwind at the next line after Stop (the guest is mostly suspended in
        // host calls, so the abort signal alone can't end it promptly).
        if (stopRequested) throw new Error("Workflow stopped");
        debug.onLine?.(n);
        if (debug.breakpoints.has(n) || stepping) {
          stepping = false;
          debug.onPaused?.(n);
          await new Promise<void>((resolve, reject) => {
            pendingResume = resolve;
            pendingReject = reject;
          });
          debug.onResumed?.();
          pendingResume = null;
          pendingReject = null;
        }
      }
    : undefined;
  if (debug) {
    debug.resume = () => pendingResume?.();
    debug.step = () => {
      stepping = true;
      pendingResume?.();
    };
    debug.stop = () => {
      stopRequested = true;
      stopMain?.(); // abort signal (backstop for long sync loops)
      pendingReject?.(new Error("Workflow stopped")); // unblock a breakpoint pause
    };
  }
  const metricDefs = safeParse<MetricDef[]>(wf.metric_defs, []);

  // Seed declared metric rows (without clobbering existing values).
  for (const def of metricDefs) {
    const now = new Date().toISOString();
    await db.execute(
      `INSERT INTO workflow_metrics (id, workflow_id, key, label, type, unit, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(workflow_id, key) DO UPDATE SET label = excluded.label, type = excluded.type, unit = excluded.unit, updated_at = excluded.updated_at`,
      [crypto.randomUUID(), id, def.key, def.label, def.type, def.unit ?? null, now],
    );
  }

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  await db.execute(
    `INSERT INTO workflow_runs (id, workflow_id, status, trigger_source, logs, started_at, created_at)
     VALUES ($1, $2, 'running', $3, '[]', $4, $5)`,
    [runId, id, opts.triggerSource, startedAt, startedAt],
  );

  const host = buildWorkflowHost({
    listPlugins: listLocalPlugins,
    getClient: async (accountId: string) =>
      createPluginClient(accountId, await pluginIdForAccount(accountId)),
    readStorageObject: async () => {
      throw new Error("Storage object reads from desktop workflows are not yet supported.");
    },
    getMetric: async (key: string) => {
      const rows = await db.select<{ value: string | null }[]>(
        "SELECT value FROM workflow_metrics WHERE workflow_id = $1 AND key = $2",
        [id, key],
      );
      const value = rows[0]?.value;
      return value == null ? null : safeParse<MetricValue>(value, null);
    },
    listMetrics: async () => {
      const rows = await db.select<{ key: string; value: string | null }[]>(
        "SELECT key, value FROM workflow_metrics WHERE workflow_id = $1 AND deleted_at IS NULL",
        [id],
      );
      const out: Record<string, MetricValue> = {};
      for (const r of rows) {
        out[r.key] = r.value == null ? null : safeParse<MetricValue>(r.value, null);
      }
      return out;
    },
    setMetric: async (key: string, value: MetricValue) => {
      const now = new Date().toISOString();
      await db.execute(
        `INSERT INTO workflow_metrics (id, workflow_id, key, label, type, value, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT(workflow_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [crypto.randomUUID(), id, key, key, metricTypeOf(value), JSON.stringify(value), now],
      );
    },
    prompt: askUser,

    // Alerts surface as native OS notifications on desktop (no Twilio/push
    // recipients exist locally), with the same per-key cooldown as the cloud.
    page: (spec) => pageFromLocalWorkflow(id, wf.name, spec),
    clearPage: (key) => clearLocalWorkflowPage(id, key),

    // Debugger: highlight the current line + pause at breakpoints (debug runs).
    ...(debugLine ? { line: debugLine } : {}),

    // Resolve ssh-key-picker create fields given by name → the key's public key.
    transformCreateFields: resolveLocalCreateSshKeyFields,

    // SSH runs in Electron main (Node ssh2); the renderer resolves the connect
    // config (host + key) and bridges the exec/stream/probe to main via IPC.
    sshExec: async (params) => {
      const config = await resolveDesktopSshConfig(params);
      return invoke("workflow_ssh_exec", {
        config,
        command: params.command,
        skipHostKeyCheck: params.skipHostKeyCheck,
      });
    },
    sshStreamStart: async (params) => {
      const config = await resolveDesktopSshConfig(params);
      return invoke("workflow_ssh_stream_start", {
        config,
        command: params.command,
        skipHostKeyCheck: params.skipHostKeyCheck,
      });
    },
    sshStreamRead: (streamId) => invoke("workflow_ssh_stream_read", { streamId }),
    sshStreamClose: async (streamId) => {
      await invoke("workflow_ssh_stream_close", { streamId });
    },

    // SFTP runs in electron main; the renderer resolves the connect config.
    sftpList: async (params, path) =>
      invoke("workflow_sftp_list", { config: await resolveDesktopSftpConfig(params), path }),
    sftpGet: async (params, path) =>
      invoke("workflow_sftp_get", { config: await resolveDesktopSftpConfig(params), path }),
    sftpPut: async (params, path, base64) => {
      await invoke("workflow_sftp_put", {
        config: await resolveDesktopSftpConfig(params),
        path,
        base64,
      });
    },
    sftpMkdir: async (params, path) => {
      await invoke("workflow_sftp_mkdir", { config: await resolveDesktopSftpConfig(params), path });
    },
    sftpDelete: async (params, path, isDir) => {
      await invoke("workflow_sftp_delete", {
        config: await resolveDesktopSftpConfig(params),
        path,
        isDir,
      });
    },
    sshProbe: async (params) => {
      // Resolve the host inside the loop: a just-created VM may not have an IP
      // yet, so keep re-resolving until it's available, then hand the TCP probe
      // (with the remaining time) to electron main — rather than failing once.
      const interval = 4_000;
      const deadline = Date.now() + (params.timeoutMs ?? 180_000);
      while (Date.now() < deadline) {
        if (stopRequested) return false; // bail out of waitUntilReachable on Stop
        const target = await resolveSshTarget(params).catch(() => null);
        if (target?.host) {
          const ok = await invoke<boolean>("workflow_ssh_probe", {
            host: target.host,
            port: params.port ?? target.port ?? 22,
            timeoutMs: Math.max(interval, deadline - Date.now()),
          });
          return ok;
        }
        if (Date.now() + interval >= deadline) break;
        await new Promise((r) => setTimeout(r, interval));
      }
      return false;
    },
  });

  const result = await runWorkflowInMain(wf.source, opts.interactive, host, {
    debug: Boolean(debug),
    onStart: (stop) => {
      stopMain = stop;
    },
    ...(debug?.onLog ? { onLog: debug.onLog } : {}),
  });

  const finishedAt = new Date(result.finishedAt).toISOString();
  await db.execute(
    `UPDATE workflow_runs SET status = $1, logs = $2, output = $3, error = $4, finished_at = $5, duration_ms = $6
     WHERE id = $7`,
    [
      result.status,
      JSON.stringify(result.logs),
      result.output === undefined ? null : JSON.stringify(result.output),
      result.error ? JSON.stringify(result.error) : null,
      finishedAt,
      result.durationMs,
      runId,
    ],
  );
  await db.execute("UPDATE workflows SET last_run_at = $1, updated_at = $2 WHERE id = $3", [
    finishedAt,
    new Date().toISOString(),
    id,
  ]);

  // The sandbox `RunResult` is structurally a `WorkflowRunResult` (its extra
  // numeric timestamps are simply not part of the narrower type).
  return { runId, result };
}
