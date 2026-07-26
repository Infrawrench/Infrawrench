/**
 * Shared, platform-agnostic workflow runner. Both the web host and the
 * poller (cron/git) drive workflows through {@link runOrgWorkflow}.
 *
 * It loads the workflow row, seeds its declared metrics, records a
 * `workflow_runs` row, builds a {@link WorkflowHost} backed by the org's
 * encrypted accounts and the `workflow_metrics` table, executes the source in
 * the isolate via the runtime, and persists the outcome.
 *
 * Automated runs (the default) are non-interactive: `infra.prompt()` and
 * storage-object reads throw, since there is no user/websocket attached.
 * The cloud web host attaches its websocket-backed callbacks (prompt,
 * storage reads, live logs, debugger) via the optional fields on
 * {@link RunOrgWorkflowOptions}.
 */
import {
  buildWorkflowHost,
  runWorkflow,
  type MetricDef,
  type MetricValue,
  type PromptSpec,
  type RunLogEntry,
  type RunResult,
  type RunTriggerSource,
  type WorkflowEvent,
  type WorkflowHost,
  type WorkflowPluginInfo,
} from "@infrawrench/workflow-runtime";
import { and, eq, isNull } from "drizzle-orm";

import { db } from "../db/client";
import { accounts, workflowMetrics, workflowRuns, workflows } from "../db/schema";
import { writeWorkflowCostRows } from "../cost/workflow-costs";
import { loadPlugins } from "../plugin-loader";
import { getOrgAccountClient } from "../org-accounts";
import { buildWorkflowSshDeps } from "./ssh-host";
import { enrichPlugin } from "./create-fields-cache";
import { buildSshKeyFieldResolver } from "./ssh-key-fields";
import { clearWorkflowPage, pageFromWorkflow } from "./paging";
import { staticResourceCapabilities } from "@infrawrench/workflow-runtime";

// Re-exported so the cloud web host (which builds its own interactive host) can
// reuse the same SSH deps, plugin enrichment, and SSH-key resolution as the
// poller.
export { buildWorkflowSshDeps } from "./ssh-host";
export { enrichPlugin } from "./create-fields-cache";
export { buildSshKeyFieldResolver, listOrgSshKeyNames } from "./ssh-key-fields";
export { getOrgAccountClient } from "../org-accounts";

/**
 * Interactive callbacks a host may attach to a run. Automated triggers
 * (poller cron/git, plain HTTP manual runs) pass none of these; the cloud
 * web host supplies them for websocket-driven manual runs (prompts, storage
 * reads, live log streaming, debugger).
 */
export interface OrgWorkflowHostExtras {
  /** Provided for interactive (manual) runs; omitted for automated triggers. */
  prompt?: (spec: PromptSpec) => Promise<MetricValue>;
  /** Default title for pages this run raises. Falls back to "Workflow". */
  workflowName?: string;
  /** The run raising a page, so its notification can deep-link to the logs. */
  runId?: string;
  /** Provided when storage object reads should be supported for this run. */
  readStorageObject?: (accountId: string, bucket: string, key: string) => Promise<Uint8Array>;
  /** Debugger line hook (instrumented runs); blocks per line until continued. */
  line?: (line: number) => Promise<void>;
  /** Abort the run (Stop) — lets in-flight SSH probes bail out. */
  signal?: AbortSignal;
}

export interface RunOrgWorkflowOptions extends OrgWorkflowHostExtras {
  organizationId: string;
  workflowId: string;
  triggerSource: RunTriggerSource;
  /** Enables `infra.prompt()` / storage reads for websocket-driven manual runs. */
  interactive?: boolean;
  /** Live log streaming callback (interactive runs). */
  onLog?: (entry: RunLogEntry) => void;
  /** Instrument the run so `line` is called before each statement (debugger). */
  debug?: boolean;
  /**
   * Trigger payload exposed to the body as `infra.event`. Budget triggers pass
   * the crossing; other sources leave it to default to `{ kind: triggerSource }`.
   */
  event?: WorkflowEvent;
}

export interface RunOrgWorkflowResult {
  runId: string;
  result: RunResult;
}

/**
 * Enumerate the org's accounts grouped by plugin, with resource-type metadata.
 *
 * `enrichCreateFields` (typings path only) additionally fetches each createable
 * type's live create config so `create({...})` is typed — it hits provider APIs,
 * so the runtime path (every run) leaves it off and uses the generic signature.
 */
export async function listOrgPlugins(
  organizationId: string,
  opts: { enrichCreateFields?: boolean } = {},
): Promise<WorkflowPluginInfo[]> {
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
          // supportsDelete defaults to true (only `false` disables deletion).
          supportsDelete: rt.supportsDelete !== false,
          storage: Boolean(rt.supportsStorageBrowser),
          capabilities: staticResourceCapabilities(rt),
        })),
      };
      byPlugin.set(row.pluginId, entry);
    }
    entry.accounts.push({ id: row.id, pluginId: row.pluginId, displayName: row.displayName });
  }

  // Best-effort (typings path): merge per-resource-type capability flags and
  // type each createable resource's fields from the live create config.
  if (opts.enrichCreateFields) {
    await Promise.all(
      Array.from(byPlugin.values()).map((entry) => {
        const first = entry.accounts[0];
        if (!first) return Promise.resolve();
        return enrichPlugin(entry, first.id, async () => {
          const ctx = await getOrgAccountClient(first.id, organizationId);
          if (!ctx) throw new Error(`Account ${first.id} not found.`);
          return ctx.client;
        });
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

async function getMetric(workflowId: string, key: string): Promise<MetricValue> {
  const [row] = await db
    .select()
    .from(workflowMetrics)
    .where(and(eq(workflowMetrics.workflowId, workflowId), eq(workflowMetrics.key, key)))
    .limit(1);
  if (!row || row.value === null || row.value === undefined) return null;
  return row.value as MetricValue;
}

async function listMetrics(workflowId: string): Promise<Record<string, MetricValue>> {
  const rows = await db
    .select()
    .from(workflowMetrics)
    .where(and(eq(workflowMetrics.workflowId, workflowId), isNull(workflowMetrics.deletedAt)));
  const out: Record<string, MetricValue> = {};
  for (const row of rows) {
    out[row.key] = (row.value ?? null) as MetricValue;
  }
  return out;
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

/**
 * Build a {@link WorkflowHost} for an org's run. With no `extras` the host is
 * non-interactive (automated triggers): `infra.prompt()` and storage-object
 * reads throw. Interactive hosts (cloud web manual runs) inject their
 * websocket-backed callbacks through `extras`.
 */
export function buildOrgWorkflowHost(
  organizationId: string,
  workflowId: string,
  extras: OrgWorkflowHostExtras = {},
): WorkflowHost {
  // Per-run row budget for infra.costs.write, closed over so the cap applies
  // across every call the workflow makes rather than per call.
  let costRowsWritten = 0;
  return buildWorkflowHost({
    listPlugins: () => listOrgPlugins(organizationId),
    getClient: async (accountId: string) => {
      const ctx = await getOrgAccountClient(accountId, organizationId);
      if (!ctx) throw new Error(`Account ${accountId} not found in this organization.`);
      return ctx.client;
    },
    readStorageObject:
      extras.readStorageObject ??
      (async () => {
        throw new Error(
          "Storage object reads from workflows are not available in this run context.",
        );
      }),
    getMetric: (key: string) => getMetric(workflowId, key),
    listMetrics: () => listMetrics(workflowId),
    setMetric: (key: string, value: MetricValue) =>
      setMetric(organizationId, workflowId, key, value),
    prompt:
      extras.prompt ??
      (async () => {
        throw new Error("This run is not interactive; infra.prompt() is unavailable.");
      }),
    writeCosts: async (rows) => {
      const result = await writeWorkflowCostRows({
        organizationId,
        workflowId,
        rows,
        writtenSoFar: costRowsWritten,
      });
      costRowsWritten += result.written;
      return result;
    },
    page: (spec) =>
      pageFromWorkflow(
        {
          organizationId,
          workflowId,
          workflowName: extras.workflowName ?? "Workflow",
          ...(extras.runId ? { runId: extras.runId } : {}),
        },
        spec,
      ),
    clearPage: (key) => clearWorkflowPage(workflowId, key),
    transformCreateFields: buildSshKeyFieldResolver(organizationId, async (accountId) => {
      const ctx = await getOrgAccountClient(accountId, organizationId);
      return ctx ? { client: ctx.client, pluginId: ctx.account.pluginId } : null;
    }),
    ...(extras.line ? { line: extras.line } : {}),
    ...buildWorkflowSshDeps(organizationId, extras.signal ? { signal: extras.signal } : {}),
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
 * The `infra.event.kind` for a run with no richer payload. A budget-sourced run
 * always supplies its own event, so "budget" here would mean a caller forgot —
 * fall back to "api" rather than claiming a crossing that isn't described.
 */
function eventKindFor(source: RunTriggerSource): "manual" | "cron" | "git" | "api" {
  return source === "budget" ? "api" : source;
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

  const host = buildOrgWorkflowHost(opts.organizationId, wf.id, {
    workflowName: wf.name,
    runId,
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
    ...(opts.readStorageObject ? { readStorageObject: opts.readStorageObject } : {}),
    ...(opts.line ? { line: opts.line } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const result = await runWorkflow({
    source: wf.source,
    host,
    interactive: Boolean(opts.interactive),
    // `api` and `budget` are both "not a person at a keyboard"; the event still
    // reports the real source so a workflow can branch on it.
    event: opts.event ?? { kind: eventKindFor(opts.triggerSource) },
    ...(opts.onLog ? { onLog: opts.onLog } : {}),
    ...(opts.debug ? { debug: true } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
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
