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
  attachSidecarInfo,
  buildWorkflowHost,
  enrichSidecarCapabilities,
  runWorkflow,
  type MetricDef,
  type MetricValue,
  type PromptSpec,
  type RunLogEntry,
  type RunResult,
  type RunTriggerSource,
  type SidecarRef,
  type WorkflowEvent,
  type WorkflowHost,
  type WorkflowPluginInfo,
} from "@infrawrench/workflow-runtime";
import { and, eq, isNull } from "drizzle-orm";

import { db } from "../db/client";
import { accounts, workflowMetrics, workflowRuns, workflows } from "../db/schema";
import { writeWorkflowCostRows } from "../cost/workflow-costs";
import { writeWorkflowMetricValues } from "../cost/workflow-metrics";
import { getPlugin, loadPlugins } from "../plugin-loader";
import { getOrgAccountClient } from "../org-accounts";
import { getClientForResource } from "../peer-clients";
import { buildWorkflowSshDeps } from "./ssh-host";
import { buildWorkflowFetch } from "./fetch";
import { enrichPlugin } from "./create-fields-cache";
import { buildSshKeyFieldResolver } from "./ssh-key-fields";
import { buildWorkflowAi } from "./ai";
import { clearWorkflowPage, pageFromWorkflow } from "./paging";
import { requestApprovalAndWait } from "./approvals";
import { buildWorkflowAuthorizer } from "./authorize";
import { staticResourceCapabilities } from "@infrawrench/workflow-runtime";

// Re-exported so the cloud web host (which builds its own interactive host) can
// reuse the same SSH deps, plugin enrichment, and SSH-key resolution as the
// poller.
export { buildWorkflowSshDeps } from "./ssh-host";
export { enrichPlugin } from "./create-fields-cache";
export { buildSshKeyFieldResolver, listOrgSshKeyNames } from "./ssh-key-fields";
export { buildWorkflowFetch, isWorkflowFetchConfigured } from "./fetch";
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
  /**
   * What started this run. Approval requests quote it so the notification can
   * say who is asking — `workflow_runs` records no user, so the trigger source
   * is the honest answer available.
   */
  triggerSource?: string;
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
  /**
   * The user this run acts on behalf of, bounding what the sandbox may do (see
   * ./authorize.ts). Manual triggers pass whoever asked for the run; automated
   * triggers omit it and the workflow's author is used instead.
   */
  runAsUserId?: string;
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
 * Resolve the plugin client a workflow operation should run against: the
 * account's own, or — for an operation on a sidecar resource — the peer
 * plugin's, built from the parent resource's outputs.
 */
async function clientForWorkflow(organizationId: string, accountId: string, sidecar?: SidecarRef) {
  if (!sidecar) {
    const ctx = await getOrgAccountClient(accountId, organizationId);
    if (!ctx) throw new Error(`Account ${accountId} not found in this organization.`);
    return ctx.client;
  }
  const ctx = await getClientForResource(
    sidecar.pluginId,
    accountId,
    organizationId,
    sidecar.parentResourceId,
  );
  if (!ctx) {
    throw new Error(
      `Could not reach the ${sidecar.pluginId} sidecar of ${sidecar.parentResourceId} — ` +
        `is that resource still around, and does it expose ${sidecar.pluginId}?`,
    );
  }
  return ctx.client;
}

/**
 * Enumerate the org's accounts grouped by plugin, with resource-type metadata.
 *
 * `enrichCreateFields` (typings path only) additionally fetches each createable
 * type's live create config so `create({...})` is typed, and probes each
 * sidecar's capability flags — both hit provider APIs, so the runtime path
 * (every run) leaves them off and uses the generic signatures.
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
  /** Plugin definitions for the entries we build, so sidecars can be attached. */
  const defsFor = new Map<string, (typeof plugins)[number]>();
  for (const row of rows) {
    let entry = byPlugin.get(row.pluginId);
    if (!entry) {
      const lp = plugins.find((p) => p.plugin.manifest.id === row.pluginId);
      if (!lp) continue;
      defsFor.set(row.pluginId, lp);
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

  // The peer plugins each resource type exposes (a cluster's `kubernetes`, a
  // managed database's `postgres`). Needed on the runtime path too — the
  // prelude builds `cluster.kubernetes` from this — so it is not gated behind
  // `enrichCreateFields`; it reads loaded plugin definitions, no API calls.
  await Promise.all(
    Array.from(byPlugin.values()).map((entry) => {
      const lp = defsFor.get(entry.pluginId);
      if (!lp) return Promise.resolve();
      return attachSidecarInfo(
        entry.resourceTypes,
        lp.plugin.resourceTypes,
        async (id) => (await getPlugin(id))?.plugin,
      );
    }),
  );

  // Best-effort (typings path): merge per-resource-type capability flags and
  // type each createable resource's fields from the live create config.
  if (opts.enrichCreateFields) {
    await Promise.all(
      Array.from(byPlugin.values()).map(async (entry) => {
        const first = entry.accounts[0];
        if (!first) return;
        await enrichPlugin(entry, first.id, async () => {
          const ctx = await getOrgAccountClient(first.id, organizationId);
          if (!ctx) throw new Error(`Account ${first.id} not found.`);
          return ctx.client;
        });
        // Type what lives inside each sidecar (pod.logs(), pod.describe(), …)
        // by probing the peer plugin through one real parent resource. Passed
        // every parent type and every account at once so the probe doesn't
        // depend on which one happens to be tried first.
        await enrichSidecarCapabilities(
          entry.resourceTypes.filter((rt) => rt.sidecars?.length),
          entry.accounts.map((a) => a.id),
          {
            listParents: async (typeId, accountId) => {
              const ctx = await getOrgAccountClient(accountId, organizationId);
              if (!ctx) return [];
              return ctx.client.listResources(typeId, accountId);
            },
            peerClient: (pluginId, parentResourceId, accountId) =>
              clientForWorkflow(organizationId, accountId, { pluginId, parentResourceId }),
          },
        );
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
  let metricValuesWritten = 0;
  return buildWorkflowHost({
    listPlugins: () => listOrgPlugins(organizationId),
    getClient: (accountId: string, sidecar?: SidecarRef) =>
      clientForWorkflow(organizationId, accountId, sidecar),
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
    writeBusinessMetricValues: async (metricKey, values) => {
      const result = await writeWorkflowMetricValues({
        organizationId,
        metricKey,
        values,
        writtenSoFar: metricValuesWritten,
      });
      metricValuesWritten += result.written;
      return result;
    },
    // Outbound HTTP leaves through the egress proxy, never from the pod the
    // isolate runs in (see ./fetch.ts).
    fetch: buildWorkflowFetch(),
    // One-shot model calls (infra.ai): made server-side with the deployment's
    // API key, metered against the org's monthly AI cap, capped per run.
    // The run abort signal cancels an in-flight Anthropic request on Stop.
    ai: buildWorkflowAi({
      organizationId,
      workflowId,
      ...(extras.runId ? { runId: extras.runId } : {}),
      ...(extras.signal ? { signal: extras.signal } : {}),
    }),
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
    // Human gate: persists a pending approval, notifies the org, and blocks
    // until a member decides or the timeout denies. The wait rides the paused
    // execution budget, so it doesn't consume the run's time.
    waitForApproval: (spec) =>
      requestApprovalAndWait(
        {
          organizationId,
          workflowId,
          workflowName: extras.workflowName ?? "Workflow",
          ...(extras.runId ? { runId: extras.runId } : {}),
          ...(extras.triggerSource ? { triggerSource: extras.triggerSource } : {}),
          ...(extras.signal ? { signal: extras.signal } : {}),
        },
        spec,
      ),
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
    triggerSource: opts.triggerSource,
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
    ...(opts.readStorageObject ? { readStorageObject: opts.readStorageObject } : {}),
    ...(opts.line ? { line: opts.line } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  // Resolved before the isolate starts, so the per-operation gate below is a
  // synchronous map lookup rather than a query on every RPC.
  const authorize = await buildWorkflowAuthorizer(opts.organizationId, wf.id, {
    userId: opts.runAsUserId,
  });

  const result = await runWorkflow({
    source: wf.source,
    host,
    authorize,
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
