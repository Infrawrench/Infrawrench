/**
 * Workflow authoring tools — let MCP clients and the chat agent write, check,
 * and run sandboxed TypeScript automations without an editor.
 *
 * The pairing matters: `get_workflow_typings` hands back the generated
 * `infra.d.ts` for the caller's *own* accounts (so the model writes against
 * real account names and resource types), and `write_workflow` type-checks the
 * source against that same file before saving — a workflow with type errors is
 * rejected with diagnostics instead of being persisted and failing at 3am.
 *
 * Everything routes through services/workflows.ts, the same module behind the
 * HTTP routes, so the two surfaces can't drift — including the permissions:
 * reads take `workflows:read`, and writing/running/deleting take
 * `workflows:write`, exactly as the matching routes do.
 */
import { z } from "zod";

import type { MetricDef, WorkflowTrigger } from "@infrawrench/workflow-runtime";

import {
  WorkflowError,
  checkWorkflowSource,
  createWorkflow,
  generateWorkflowTypings,
  listWorkflowMetrics,
  listWorkflowRuns,
  listWorkflows,
  requireWorkflow,
  softDeleteWorkflow,
  updateWorkflow,
} from "../services/workflows";
import { runWorkflowById } from "../services/workflow-runner";
import { logAudit } from "../services/audit";
import { denyUnlessPermitted } from "./permissions";
import { ok, okText, err, type ToolDefinition, type ToolResult } from "./types";

/**
 * Flat trigger shape. Deliberately not a discriminated union: the same schema
 * has to survive conversion to two different providers' JSON-Schema dialects,
 * and the service layer validates the combination anyway.
 */
const triggerSchema = z
  .object({
    kind: z.enum(["manual", "cron", "git", "budget"]),
    expression: z.string().optional().describe("cron only: 5-field expression, e.g. '0 9 * * 1'."),
    timezone: z.string().optional().describe("cron only: IANA zone. Defaults to UTC."),
    repo: z.string().optional().describe("git only: 'owner/name'."),
    branch: z.string().optional().describe("git only: branch to watch."),
    installationId: z.number().optional().describe("git only: GitHub App installation id."),
    budgetId: z
      .string()
      .optional()
      .describe("budget only: the budget to watch. Get ids from list_budgets."),
    percent: z
      .number()
      .optional()
      .describe("budget only: fire at this percentage of the budget amount. Defaults to 100."),
    metric: z
      .enum(["actual", "forecast"])
      .optional()
      .describe(
        "budget only: compare month-to-date 'actual' spend (default) or the projected month-end 'forecast'.",
      ),
  })
  .describe(
    "How the workflow starts. manual = only when run by hand; cron = on a schedule; " +
      "git = on a push to a watched branch; budget = when a cost budget crosses a threshold.",
  );

const metricsSchema = z
  .array(
    z.object({
      key: z.string().describe("Identifier used as infra.metrics.<key>."),
      label: z.string(),
      type: z.enum(["number", "string", "boolean"]),
      unit: z.string().optional(),
    }),
  )
  .describe(
    "Metrics the workflow can read/write via infra.metrics.<key>. They become typed properties " +
      "in the generated typings and render on any dashboard the workflow is pinned to.",
  );

type TriggerInput = z.infer<typeof triggerSchema>;

/** Build a stored trigger from the flat tool input. */
function toTrigger(input: TriggerInput): WorkflowTrigger {
  switch (input.kind) {
    case "cron":
      return {
        kind: "cron",
        expression: input.expression ?? "0 * * * *",
        ...(input.timezone ? { timezone: input.timezone } : {}),
      };
    case "git":
      return {
        kind: "git",
        provider: "github",
        ...(input.repo ? { repo: input.repo } : {}),
        ...(input.branch ? { branch: input.branch } : {}),
        ...(input.installationId ? { installationId: input.installationId } : {}),
        events: ["push"],
      };
    case "budget":
      return {
        kind: "budget",
        budgetId: input.budgetId ?? "",
        ...(input.percent !== undefined ? { percent: input.percent } : {}),
        ...(input.metric ? { metric: input.metric } : {}),
      };
    default:
      return { kind: "manual" };
  }
}

/** One diagnostic as a compact `line:col  TS####  message` line. */
function formatDiagnostics(
  diagnostics: { line: number; column: number; code: number; message: string; category: string }[],
): string {
  return diagnostics
    .map((d) => `  ${d.line}:${d.column}  ${d.category} TS${d.code}  ${d.message}`)
    .join("\n");
}

/** Turn a service-level failure into a tool error result. */
function toolError(e: unknown): ToolResult {
  if (e instanceof WorkflowError) return err(e.message);
  throw e;
}

/** Summary shape returned by the list/get/write tools. */
function summarize(wf: Awaited<ReturnType<typeof requireWorkflow>>, includeSource: boolean) {
  return {
    id: wf.id,
    name: wf.name,
    description: wf.description,
    trigger: wf.trigger,
    metrics: wf.metricDefs,
    enabled: wf.enabled,
    lastRunAt: wf.lastRunAt,
    nextRunAt: wf.nextRunAt,
    updatedAt: wf.updatedAt,
    ...(includeSource ? { source: wf.source } : {}),
  };
}

export function workflowTools(): ToolDefinition[] {
  return [
    {
      name: "list_workflows",
      title: "List workflows",
      description:
        "List the organization's workflows (sandboxed TypeScript automations) with their trigger, " +
        "declared metrics, enabled state, and last/next run times. Source is omitted — use " +
        "get_workflow for that.",
      inputSchema: {},
      risk: "read",
      permission: "workflows:read",
      handler: async (_input, auth) => {
        const denied = await denyUnlessPermitted(auth, "workflows:read");
        if (denied) return denied;
        const rows = await listWorkflows(auth.organizationId);
        return ok(rows.map((wf) => summarize(wf, false)));
      },
    },

    {
      name: "get_workflow",
      title: "Get workflow",
      description:
        "Fetch one workflow including its full TypeScript source, declared metrics, current metric " +
        "values, and its most recent runs (status, logs, error).",
      inputSchema: {
        workflowId: z.string(),
        runLimit: z.number().optional().describe("How many recent runs to include. Default 5."),
      },
      risk: "read",
      permission: "workflows:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "workflows:read");
        if (denied) return denied;
        const id = input["workflowId"] as string;
        try {
          const wf = await requireWorkflow(auth.organizationId, id);
          const limit = Math.max(0, Math.min(20, (input["runLimit"] as number) ?? 5));
          const [runs, metrics] = await Promise.all([
            limit > 0 ? listWorkflowRuns(wf.id, limit) : Promise.resolve([]),
            listWorkflowMetrics(wf.id),
          ]);
          return ok({ ...summarize(wf, true), metricValues: metrics, runs });
        } catch (e) {
          return toolError(e);
        }
      },
    },

    {
      name: "get_workflow_typings",
      title: "Get workflow typings",
      description:
        "Return the generated `infra.d.ts` that workflow source is written against — the same " +
        "ambient declarations the editor uses, specialized with THIS organization's real account " +
        "names, resource types, create-field shapes, SSH key names, and the workflow's declared " +
        "metrics. ALWAYS call this before writing or editing workflow source: the `infra` API is " +
        "generated per organization and cannot be guessed. Pass workflowId to type against an " +
        "existing workflow, or pass triggerKind/metrics to preview the typings for one you are " +
        "about to create (a budget trigger types `infra.event` with the crossing payload; only " +
        "manual workflows get `infra.prompt`).",
      inputSchema: {
        workflowId: z
          .string()
          .optional()
          .describe("Type against an existing workflow's trigger + metrics."),
        triggerKind: z
          .enum(["manual", "cron", "git", "budget"])
          .optional()
          .describe("Ignored when workflowId is given. Defaults to manual."),
        metrics: metricsSchema.optional(),
      },
      risk: "read",
      permission: "workflows:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "workflows:read");
        if (denied) return denied;
        const workflowId = input["workflowId"] as string | undefined;
        try {
          let metrics = (input["metrics"] as MetricDef[] | undefined) ?? [];
          let triggerKind =
            (input["triggerKind"] as WorkflowTrigger["kind"] | undefined) ?? "manual";
          if (workflowId) {
            const wf = await requireWorkflow(auth.organizationId, workflowId);
            metrics = (wf.metricDefs ?? []) as MetricDef[];
            triggerKind = (wf.trigger as WorkflowTrigger).kind;
          }
          return okText(
            await generateWorkflowTypings(auth.organizationId, { metrics, triggerKind }),
          );
        } catch (e) {
          return toolError(e);
        }
      },
    },

    {
      name: "check_workflow_source",
      title: "Type-check workflow source",
      description:
        "Type-check a candidate workflow source against this organization's generated typings " +
        "WITHOUT saving anything. Returns the same diagnostics the editor would show. Use it to " +
        "iterate on a draft; write_workflow runs the same check before it saves.",
      inputSchema: {
        source: z.string(),
        workflowId: z
          .string()
          .optional()
          .describe("Check against an existing workflow's trigger + metrics."),
        triggerKind: z.enum(["manual", "cron", "git", "budget"]).optional(),
        metrics: metricsSchema.optional(),
      },
      risk: "read",
      permission: "workflows:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "workflows:read");
        if (denied) return denied;
        try {
          let metrics = (input["metrics"] as MetricDef[] | undefined) ?? [];
          let triggerKind =
            (input["triggerKind"] as WorkflowTrigger["kind"] | undefined) ?? "manual";
          const workflowId = input["workflowId"] as string | undefined;
          if (workflowId) {
            const wf = await requireWorkflow(auth.organizationId, workflowId);
            metrics = (wf.metricDefs ?? []) as MetricDef[];
            triggerKind = (wf.trigger as WorkflowTrigger).kind;
          }
          const result = await checkWorkflowSource(auth.organizationId, input["source"] as string, {
            metrics,
            triggerKind,
          });
          return ok(result);
        } catch (e) {
          return toolError(e);
        }
      },
    },

    {
      name: "write_workflow",
      title: "Write workflow",
      description:
        "Create a workflow (omit workflowId) or update one (pass workflowId). The source is a " +
        "TypeScript program run in a sandboxed isolate against the global `infra` object — call " +
        "get_workflow_typings FIRST so you write against this organization's real accounts. " +
        "Before saving, the source is type-checked against those same typings and the save is " +
        "REJECTED with diagnostics if it has errors: read them, fix the source, and call again " +
        "(set skipTypecheck to save anyway). To alert a human when the workflow finds a problem, " +
        "call `infra.page(message, { key })` in the source — it delivers SMS and mobile push to " +
        "the org's paging recipients and throttles repeats per key, so a monitoring cron can page " +
        "unconditionally and only the first occurrence gets through. Prefer a cron trigger plus " +
        "`infra.page` over asking the user to watch something themselves. " +
        "A global `fetch(url, init)` is available for HTTP APIs Infrawrench has no plugin for; it " +
        "goes through a proxy outside the cluster, so only PUBLIC addresses are reachable — a " +
        "private/loopback/cluster-internal URL is refused at runtime. " +
        "Only fields you pass are changed. Audit-logged.",
      inputSchema: {
        workflowId: z.string().optional().describe("Omit to create a new workflow."),
        name: z.string().optional(),
        description: z.string().optional(),
        source: z.string().optional().describe("The TypeScript body. Top-level await is allowed."),
        trigger: triggerSchema.optional(),
        metrics: metricsSchema.optional(),
        enabled: z.boolean().optional(),
        skipTypecheck: z
          .boolean()
          .optional()
          .describe("Save even when the source has type errors. Use only when deliberate."),
      },
      risk: "write",
      permission: "workflows:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "workflows:write");
        if (denied) return denied;
        const workflowId = input["workflowId"] as string | undefined;

        try {
          const existing = workflowId
            ? await requireWorkflow(auth.organizationId, workflowId)
            : undefined;

          const triggerInput = input["trigger"] as TriggerInput | undefined;
          const trigger: WorkflowTrigger = triggerInput
            ? toTrigger(triggerInput)
            : ((existing?.trigger as WorkflowTrigger | undefined) ?? { kind: "manual" });
          const metrics =
            (input["metrics"] as MetricDef[] | undefined) ??
            ((existing?.metricDefs ?? []) as MetricDef[]);
          const source = (input["source"] as string | undefined) ?? existing?.source ?? "";

          // Type-check the *resulting* workflow, not just the new source: a
          // trigger change alone can invalidate it (infra.prompt disappears for
          // automated triggers, infra.event changes shape).
          let check: Awaited<ReturnType<typeof checkWorkflowSource>> | undefined;
          if (source.trim() && !input["skipTypecheck"]) {
            check = await checkWorkflowSource(auth.organizationId, source, {
              metrics,
              triggerKind: trigger.kind,
            });
            if (check.hasErrors) {
              return err(
                `Not saved — the workflow source has type errors:\n${formatDiagnostics(check.diagnostics)}\n\n` +
                  "Call get_workflow_typings to see the available `infra` API, fix the source, and " +
                  "call write_workflow again.",
              );
            }
          }

          const body = {
            ...(input["name"] !== undefined ? { name: input["name"] as string } : {}),
            ...(input["description"] !== undefined
              ? { description: input["description"] as string }
              : {}),
            ...(input["source"] !== undefined ? { source } : {}),
            ...(triggerInput ? { trigger } : {}),
            ...(input["metrics"] !== undefined ? { metrics } : {}),
            ...(input["enabled"] !== undefined ? { enabled: input["enabled"] as boolean } : {}),
          };

          const saved = existing
            ? await updateWorkflow(auth.organizationId, existing.id, body)
            : await createWorkflow(auth.organizationId, body, auth.userId);

          void logAudit({
            organizationId: auth.organizationId,
            userId: auth.userId,
            action: existing ? "workflow.update" : "workflow.create",
            entityType: "workflow",
            entityId: saved.id,
            metadata: {
              name: saved.name,
              trigger: (saved.trigger as WorkflowTrigger).kind,
              source: auth.source,
            },
          });

          return ok({
            ...summarize(saved, true),
            ...(check
              ? {
                  typecheck: {
                    warnings: check.diagnostics,
                    // A degraded check only inspected syntax — say so rather
                    // than implying the types were verified.
                    ...(check.degraded
                      ? { note: "Type checking was unavailable; only syntax was checked." }
                      : {}),
                  },
                }
              : {}),
          });
        } catch (e) {
          return toolError(e);
        }
      },
    },

    {
      name: "run_workflow",
      title: "Run workflow",
      description:
        "Run a workflow now and return its outcome (status, log lines, output, error). " +
        "Non-interactive: `infra.prompt()` throws. Use this to verify a workflow you just wrote. " +
        "The workflow's own code may create or delete real infrastructure — read the source first " +
        "if you did not write it. The chat surface confirms with the user before invoking.",
      inputSchema: { workflowId: z.string() },
      // Destructive-tier despite not deleting anything itself: it executes
      // arbitrary user code that can, so it gets the same confirmation as
      // invoke_action / apply_manifest.
      risk: "destructive",
      permission: "workflows:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "workflows:write");
        if (denied) return denied;
        const id = input["workflowId"] as string;
        try {
          await requireWorkflow(auth.organizationId, id);
          const { runId, result } = await runWorkflowById({
            organizationId: auth.organizationId,
            workflowId: id,
            triggerSource: auth.source === "chat" ? "manual" : "api",
            interactive: false,
          });
          void logAudit({
            organizationId: auth.organizationId,
            userId: auth.userId,
            action: "workflow.run",
            entityType: "workflow",
            entityId: id,
            metadata: { runId, status: result.status, source: auth.source },
          });
          return ok({ runId, ...result });
        } catch (e) {
          return toolError(e);
        }
      },
    },

    {
      name: "delete_workflow",
      title: "Delete workflow",
      description:
        "Delete a workflow (soft delete — its run history is retained). Audit-logged. The chat " +
        "surface confirms with the user before invoking.",
      inputSchema: { workflowId: z.string() },
      risk: "destructive",
      permission: "workflows:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "workflows:write");
        if (denied) return denied;
        const id = input["workflowId"] as string;
        try {
          await softDeleteWorkflow(auth.organizationId, id);
          void logAudit({
            organizationId: auth.organizationId,
            userId: auth.userId,
            action: "workflow.delete",
            entityType: "workflow",
            entityId: id,
            metadata: { source: auth.source },
          });
          return ok({ ok: true });
        } catch (e) {
          return toolError(e);
        }
      },
    },
  ];
}
