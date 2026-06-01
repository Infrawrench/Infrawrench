/**
 * Orchestrates a single workflow run on the web/cloud side.
 *
 * The non-interactive path (automated triggers and the manual HTTP run, which
 * is itself non-interactive) delegates to the shared
 * `@infrawrench/server-core/workflows/runner`, so web and the poller share one
 * implementation. The interactive path (websocket-driven manual runs with
 * `infra.prompt()` / storage reads) stays here, since it needs web-only
 * callbacks (`prompt`, `readStorageObject`, `onLog`).
 */
import {
  runWorkflow,
  type MetricDef,
  type MetricValue,
  type PromptSpec,
  type RunLogEntry,
  type RunResult,
  type RunTriggerSource,
} from "@infrawrench/workflow-runtime";
import { and, eq } from "drizzle-orm";

import { db } from "@infrawrench/server-core/db/client";
import { workflowMetrics, workflowRuns, workflows } from "@infrawrench/server-core/db/schema";
import { runOrgWorkflow } from "@infrawrench/server-core/workflows/runner";

import { buildOrgWorkflowHost } from "./workflow-host";

export interface RunWorkflowByIdOptions {
  organizationId: string;
  workflowId: string;
  triggerSource: RunTriggerSource;
  interactive?: boolean;
  prompt?: (spec: PromptSpec) => Promise<MetricValue>;
  readStorageObject?: (accountId: string, bucket: string, key: string) => Promise<Uint8Array>;
  onLog?: (entry: RunLogEntry) => void;
  /** Instrument the run so `line` is called before each statement (debugger). */
  debug?: boolean;
  /** Debugger line hook (blocks per line; the client decides when to continue). */
  line?: (line: number) => Promise<void>;
  /** Abort the run (Stop button). */
  signal?: AbortSignal;
}

export interface RunWorkflowByIdResult {
  runId: string;
  result: RunResult;
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

export async function runWorkflowById(
  opts: RunWorkflowByIdOptions,
): Promise<RunWorkflowByIdResult> {
  // Non-interactive runs (automated triggers and the plain HTTP manual run) have
  // no prompt/storage/log/debug callbacks; route them through the shared runner
  // so the web server and the poller execute workflows identically.
  if (!opts.interactive && !opts.prompt && !opts.readStorageObject && !opts.onLog && !opts.debug) {
    return runOrgWorkflow({
      organizationId: opts.organizationId,
      workflowId: opts.workflowId,
      triggerSource: opts.triggerSource,
    });
  }

  // Interactive path: needs web-only callbacks (websocket prompts, storage
  // reads, live log streaming), so it builds the host locally.
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

  const host = await buildOrgWorkflowHost({
    organizationId: opts.organizationId,
    workflowId: wf.id,
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
    ...(opts.readStorageObject ? { readStorageObject: opts.readStorageObject } : {}),
    ...(opts.line ? { line: opts.line } : {}),
  });

  const result = await runWorkflow({
    source: wf.source,
    host,
    interactive: Boolean(opts.interactive),
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
