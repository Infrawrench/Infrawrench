/**
 * Shared, platform-agnostic workflow runner for automated (non-interactive)
 * triggers. Both the web manual-run route and the poller (cron/git) drive
 * workflows through {@link runOrgWorkflow}.
 *
 * It loads the workflow row, seeds its declared metrics, records a
 * `workflow_runs` row, builds a {@link WorkflowHost} backed by the org's
 * encrypted accounts and the `workflow_metrics` table, executes the source in
 * the isolate via the runtime, and persists the outcome.
 *
 * Automated runs are non-interactive: `infra.prompt()` and storage-object
 * reads throw, since there is no user/websocket attached.
 */
import {
  buildWorkflowHost,
  runWorkflow,
  type MetricDef,
  type MetricValue,
  type RunResult,
  type RunTriggerSource,
  type WorkflowHost,
  type WorkflowPluginInfo,
} from "@infrawrench/workflow-runtime";
import { and, eq, isNull } from "drizzle-orm";

import { db } from "../db/client";
import { accounts, workflowMetrics, workflowRuns, workflows } from "../db/schema";
import { decrypt, buildAad } from "../encryption";
import { getPlugin, loadPlugins } from "../plugin-loader";
import { buildPluginHostServices } from "../host-services";
import { applyCredentialRewriters } from "../credential-rewriters";

export interface RunOrgWorkflowOptions {
  organizationId: string;
  workflowId: string;
  triggerSource: RunTriggerSource;
}

export interface RunOrgWorkflowResult {
  runId: string;
  result: RunResult;
}

/** Enumerate the org's accounts grouped by plugin, with resource-type metadata. */
export async function listOrgPlugins(organizationId: string): Promise<WorkflowPluginInfo[]> {
  const rows = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt)));
  const plugins = await loadPlugins();

  const byPlugin = new Map<string, WorkflowPluginInfo>();
  for (const row of rows) {
    let entry = byPlugin.get(row.pluginId);
    if (!entry) {
      const lp = plugins.find((p) => p.plugin.manifest.id === row.pluginId);
      if (!lp) continue;
      entry = {
        pluginId: row.pluginId,
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
      byPlugin.set(row.pluginId, entry);
    }
    entry.accounts.push({ id: row.id, pluginId: row.pluginId, displayName: row.displayName });
  }
  return Array.from(byPlugin.values());
}

/** Decrypt an account's credentials and instantiate its plugin client. */
async function getOrgAccountClient(accountId: string, organizationId: string) {
  const [account] = await db
    .select({
      id: accounts.id,
      pluginId: accounts.pluginId,
      encryptedCredentials: accounts.encryptedCredentials,
      credentialsIv: accounts.credentialsIv,
      bastionId: accounts.bastionId,
    })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)))
    .limit(1);
  if (!account) return null;

  const plaintext = await decrypt(
    account.encryptedCredentials,
    account.credentialsIv,
    buildAad("account", account.id, "credentials"),
  );
  const credentials = JSON.parse(plaintext) as Record<string, string>;

  await applyCredentialRewriters({ orgId: organizationId, accountId }, credentials);

  const loaded = await getPlugin(account.pluginId);
  if (!loaded) return null;

  const hostServices = await buildPluginHostServices(loaded.plugin.manifest, credentials, {
    accountId,
    bastionId: account.bastionId ?? null,
  });
  const client = loaded.plugin.createClient(credentials, hostServices);
  return { client, plugin: loaded.plugin, credentials, account };
}

function metricTypeOf(value: MetricValue): "number" | "string" | "boolean" {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

async function getMetric(workflowId: string, key: string): Promise<MetricValue> {
  const [row] = await db
    .select()
    .from(workflowMetrics)
    .where(and(eq(workflowMetrics.workflowId, workflowId), eq(workflowMetrics.key, key)))
    .limit(1);
  if (!row || row.value === null || row.value === undefined) return null;
  return row.value as MetricValue;
}

async function setMetric(
  organizationId: string,
  workflowId: string,
  key: string,
  value: MetricValue,
): Promise<void> {
  const now = new Date();
  await db
    .insert(workflowMetrics)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      workflowId,
      key,
      label: key,
      type: metricTypeOf(value),
      value,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [workflowMetrics.workflowId, workflowMetrics.key],
      set: { value, updatedAt: now },
    });
}

/** Build a non-interactive {@link WorkflowHost} for an org's automated run. */
export function buildOrgWorkflowHost(organizationId: string, workflowId: string): WorkflowHost {
  return buildWorkflowHost({
    listPlugins: () => listOrgPlugins(organizationId),
    getClient: async (accountId: string) => {
      const ctx = await getOrgAccountClient(accountId, organizationId);
      if (!ctx) throw new Error(`Account ${accountId} not found in this organization.`);
      return ctx.client;
    },
    readStorageObject: async () => {
      throw new Error("Storage object reads from workflows are not available in this run context.");
    },
    getMetric: (key: string) => getMetric(workflowId, key),
    setMetric: (key: string, value: MetricValue) =>
      setMetric(organizationId, workflowId, key, value),
    prompt: async () => {
      throw new Error("This run is not interactive; infra.prompt() is unavailable.");
    },
  });
}

async function seedMetrics(
  organizationId: string,
  workflowId: string,
  defs: MetricDef[],
): Promise<void> {
  const now = new Date();
  for (const def of defs) {
    await db
      .insert(workflowMetrics)
      .values({
        id: crypto.randomUUID(),
        organizationId,
        workflowId,
        key: def.key,
        label: def.label,
        type: def.type,
        unit: def.unit ?? null,
        value: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [workflowMetrics.workflowId, workflowMetrics.key],
        set: { label: def.label, type: def.type, unit: def.unit ?? null, updatedAt: now },
      });
  }
}

/**
 * Execute a single workflow run for an automated (cron/git) or manual trigger.
 * Persists a `workflow_runs` row, runs the source in the isolate, records the
 * outcome, and bumps `workflows.lastRunAt`.
 */
export async function runOrgWorkflow(opts: RunOrgWorkflowOptions): Promise<RunOrgWorkflowResult> {
  const [wf] = await db
    .select()
    .from(workflows)
    .where(
      and(eq(workflows.id, opts.workflowId), eq(workflows.organizationId, opts.organizationId)),
    )
    .limit(1);
  if (!wf) throw new Error("Workflow not found");

  const metricDefs = (wf.metricDefs ?? []) as MetricDef[];
  await seedMetrics(opts.organizationId, wf.id, metricDefs);

  const runId = crypto.randomUUID();
  const startedAt = new Date();
  await db.insert(workflowRuns).values({
    id: runId,
    organizationId: opts.organizationId,
    workflowId: wf.id,
    status: "running",
    triggerSource: opts.triggerSource,
    logs: [],
    startedAt,
  });

  const host = buildOrgWorkflowHost(opts.organizationId, wf.id);

  const result = await runWorkflow({
    source: wf.source,
    host,
    interactive: false,
  });

  const finishedAt = new Date(result.finishedAt);
  await db
    .update(workflowRuns)
    .set({
      status: result.status,
      logs: result.logs,
      output: result.output ?? null,
      error: result.error ?? null,
      finishedAt,
      durationMs: result.durationMs,
    })
    .where(eq(workflowRuns.id, runId));
  await db
    .update(workflows)
    .set({ lastRunAt: finishedAt, updatedAt: new Date() })
    .where(eq(workflows.id, wf.id));

  return { runId, result };
}
