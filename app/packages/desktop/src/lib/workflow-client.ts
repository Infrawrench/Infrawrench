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
  createFieldsFromConfig,
  generateInfraDts,
  type MetricDef,
  type MetricValue,
  type PromptSpec,
  type WorkflowCreateFieldInfo,
  type WorkflowPluginInfo,
  type WorkflowResourceTypeInfo,
} from "@infrawrench/workflow-runtime/client";

import { runWorkflowInMain } from "./workflow-runner";
import { requestWorkflowPrompt } from "./workflow-prompt";
import type {
  WorkflowClient,
  WorkflowMetricRow,
  WorkflowRunRow,
  WorkflowSaveBody,
  WorkflowSummary,
  WorkflowTrigger,
} from "@infrawrench/ui/workflows";

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

/**
 * Best-effort: type each createable resource's fields from the plugin's live
 * create config so `create({...})` autocompletes real keys/options instead of
 * `Record<string, string>`. Mutates `resourceTypes` in place.
 */
async function enrichLocalCreateFields(
  pluginId: string,
  resourceTypes: WorkflowResourceTypeInfo[],
  firstAccountId: string,
): Promise<void> {
  const createable = resourceTypes.filter((rt) => rt.supportsCreate);
  if (createable.length === 0) return;
  const now = Date.now();
  const needsFetch = createable.some((rt) => {
    const hit = createFieldsCache.get(`${pluginId}:${rt.id}`);
    return !hit || now - hit.at > CREATE_FIELDS_TTL_MS;
  });
  let client: Awaited<ReturnType<typeof createPluginClient>> | null = null;
  if (needsFetch) {
    try {
      client = await createPluginClient(firstAccountId, pluginId);
    } catch {
      client = null;
    }
  }
  for (const rt of createable) {
    const key = `${pluginId}:${rt.id}`;
    let entry = createFieldsCache.get(key);
    if (!entry || now - entry.at > CREATE_FIELDS_TTL_MS) {
      let value: WorkflowCreateFieldInfo[] | null = null;
      if (client?.getCreateConfig) {
        try {
          value = createFieldsFromConfig(await client.getCreateConfig(rt.id));
        } catch {
          value = null;
        }
      }
      entry = { at: now, value };
      createFieldsCache.set(key, entry);
    }
    if (entry.value && entry.value.length > 0) rt.createFields = entry.value;
  }
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
          supportsDelete: Boolean(rt.supportsDelete),
          storage: Boolean(rt.supportsStorageBrowser),
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
        return first
          ? enrichLocalCreateFields(entry.pluginId, entry.resourceTypes, first.id)
          : Promise.resolve();
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
  const host = await client.resolveOutput(
    params.typeId,
    params.resourceId,
    sshEndpoint.hostOutputKey,
    params.accountId,
  );
  if (!host) {
    throw new Error(
      `Could not resolve the SSH host (output "${sshEndpoint.hostOutputKey}") for this resource — is it running yet?`,
    );
  }
  return { host, port: 22, username: params.username ?? sshEndpoint.defaultUsername ?? "root" };
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
      const plugins = await listLocalPlugins({ enrichCreateFields: true });
      const trigger = wf
        ? safeParse<WorkflowTrigger>(wf.trigger, { kind: "manual" })
        : { kind: "manual" as const };
      return generateInfraDts({
        plugins,
        metrics: wf ? safeParse<MetricDef[]>(wf.metric_defs, []) : [],
        interactive: trigger.kind === "manual",
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

    async run(id: string) {
      return runWorkflowById(id, { interactive: true, triggerSource: "manual" });
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
  opts: { interactive: boolean; triggerSource: string } = {
    interactive: true,
    triggerSource: "manual",
  },
): Promise<{ runId: string; result: WorkflowRunRow }> {
  const wf = await loadRow(id);
  if (!wf) throw new Error("Workflow not found");
  const db = await getDb();
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

    // SSH runs in Electron main (Node ssh2); the renderer resolves the connect
    // config (host + key) and bridges the exec/stream/probe to main via IPC.
    sshExec: async (params) => {
      const config = await resolveDesktopSshConfig(params);
      return invoke("workflow_ssh_exec", { config, command: params.command });
    },
    sshStreamStart: async (params) => {
      const config = await resolveDesktopSshConfig(params);
      return invoke("workflow_ssh_stream_start", { config, command: params.command });
    },
    sshStreamRead: (streamId) => invoke("workflow_ssh_stream_read", { streamId }),
    sshStreamClose: async (streamId) => {
      await invoke("workflow_ssh_stream_close", { streamId });
    },
    sshProbe: async (params) => {
      const target = await resolveSshTarget(params).catch(() => null);
      if (!target) return false;
      return invoke<boolean>("workflow_ssh_probe", {
        host: target.host,
        port: params.port ?? target.port ?? 22,
        timeoutMs: params.timeoutMs ?? 180_000,
      });
    },
  });

  const result = await runWorkflowInMain(wf.source, opts.interactive, host);

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

  return { runId, result: result as unknown as WorkflowRunRow };
}
