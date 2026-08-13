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

import type {
  InfraDtsNamedType,
  MetricDef,
  WorkflowSecretRef,
  WorkflowTrigger,
} from "@infrawrench/workflow-runtime";

import {
  WorkflowError,
  checkWorkflowSource,
  createWorkflow,
  generateWorkflowTypingsParts,
  listWorkflowMetrics,
  listWorkflowRuns,
  listWorkflows,
  requireWorkflow,
  softDeleteWorkflow,
  updateWorkflow,
} from "../services/workflows";
import { runWorkflowById } from "../services/workflow-runner";
import { logAudit } from "../services/audit";
import {
  WorkflowSecretError,
  createWorkflowSecret,
  deleteWorkflowSecret,
  listAssignedWorkflowSecrets,
  listWorkflowSecrets,
  updateWorkflowSecretMetadata,
} from "../services/workflow-secrets";
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

/**
 * Below this size the full `infra.d.ts` is returned in one call; above it the
 * default response becomes the global scope plus an index of named interfaces
 * so a many-plugin org doesn't dump a huge file into the model's context.
 * Roughly 8k tokens.
 */
const FULL_TYPINGS_INLINE_LIMIT = 32_000;

/**
 * A plugin id as it appears inside generated interface names. MUST stay
 * byte-identical to codegen's `ident` so plugin-id lookups resolve.
 */
function pluginIdent(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/**
 * Resolve one requested type name: an exact interface name matches itself,
 * and a plugin id matches every interface generated for that plugin (group,
 * account, resources, sidecar).
 */
function matchTypeName(types: InfraDtsNamedType[], raw: string): InfraDtsNamedType[] {
  const exact = types.filter((t) => t.name === raw);
  if (exact.length > 0) return exact;
  const safe = pluginIdent(raw);
  return types.filter(
    (t) =>
      t.name === `Account_${safe}` ||
      t.name === `AccountGroup_${safe}` ||
      t.name === `Sidecar_${safe}` ||
      t.name.startsWith(`Resource_${safe}_`),
  );
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
  if (e instanceof WorkflowError || e instanceof WorkflowSecretError) return err(e.message);
  throw e;
}

function secretRefs(secrets: Array<{ id: string; name: string }>): WorkflowSecretRef[] {
  return secrets.map((secret) => ({ key: secret.id, name: secret.name }));
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
      name: "list_workflow_secrets",
      title: "List workflow secrets",
      description:
        "List reusable organization-level workflow secret metadata. Values are never returned; " +
        "hasValue only reports whether a value was supplied through the HTTP API.",
      inputSchema: {},
      risk: "read",
      permission: "secrets:read",
      handler: async (_input, auth) => {
        const denied = await denyUnlessPermitted(auth, "secrets:read");
        if (denied) return denied;
        return ok(await listWorkflowSecrets(auth.organizationId));
      },
    },

    {
      name: "write_workflow_secret",
      title: "Write workflow secret",
      description:
        "Request a write-only value for a reusable workflow secret. In Infrawrench chat this opens " +
        "a human-only password prompt whose value never enters model context. MCP exposes the same " +
        "metadata-only tool but cannot accept or change the value; complete it securely in Infrawrench.",
      inputSchema: {
        secretId: z.string().optional().describe("Omit to create metadata."),
        name: z.string().describe("Secret name, used in infra.secrets.<name>."),
        title: z
          .string()
          .optional()
          .describe("Title shown on Infrawrench's secure password prompt."),
        description: z
          .string()
          .nullable()
          .optional()
          .describe("Secret description and secure-prompt guidance."),
      },
      risk: "write",
      permission: "secrets:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "secrets:write");
        if (denied) return denied;
        const secretId = input["secretId"] as string | undefined;
        const name = input["name"] as string;
        try {
          const secret = secretId
            ? await updateWorkflowSecretMetadata(auth.organizationId, secretId, {
                name,
                ...(input["description"] !== undefined
                  ? { description: input["description"] as string | null }
                  : {}),
              })
            : await createWorkflowSecret(auth.organizationId, {
                name,
                ...(input["description"] !== undefined
                  ? { description: input["description"] as string | null }
                  : {}),
              });
          void logAudit({
            organizationId: auth.organizationId,
            userId: auth.userId,
            action: secretId ? "workflow_secret.update" : "workflow_secret.create",
            entityType: "workflow_secret",
            entityId: secret.id,
            metadata: { name: secret.name, source: auth.source },
          });
          return ok({
            ...secret,
            valueStatus: secretId
              ? `unchanged (${secret.hasValue ? "set" : "not set"})`
              : "not set",
          });
        } catch (e) {
          return toolError(e);
        }
      },
    },

    {
      name: "delete_workflow_secret",
      title: "Delete workflow secret",
      description:
        "Delete reusable workflow secret metadata, its encrypted value, and all workflow assignments. Audit-logged.",
      inputSchema: { secretId: z.string() },
      risk: "destructive",
      permission: "secrets:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "secrets:write");
        if (denied) return denied;
        try {
          const secret = await deleteWorkflowSecret(
            auth.organizationId,
            input["secretId"] as string,
          );
          void logAudit({
            organizationId: auth.organizationId,
            userId: auth.userId,
            action: "workflow_secret.delete",
            entityType: "workflow_secret",
            entityId: secret.id,
            metadata: { name: secret.name, hadValue: secret.hasValue, source: auth.source },
          });
          return ok({ ok: true });
        } catch (e) {
          return toolError(e);
        }
      },
    },

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
        const secretsDenied = await denyUnlessPermitted(auth, "secrets:read");
        const canReadSecrets = secretsDenied === null;
        const id = input["workflowId"] as string;
        try {
          const wf = await requireWorkflow(auth.organizationId, id);
          const limit = Math.max(0, Math.min(20, (input["runLimit"] as number) ?? 5));
          const [runs, metrics, assignedSecrets] = await Promise.all([
            limit > 0 ? listWorkflowRuns(wf.id, limit) : Promise.resolve([]),
            listWorkflowMetrics(wf.id),
            canReadSecrets
              ? listAssignedWorkflowSecrets(auth.organizationId, wf.id)
              : Promise.resolve([]),
          ]);
          return ok({
            ...summarize(wf, true),
            ...(canReadSecrets
              ? {
                  secretIds: assignedSecrets.map((secret) => secret.id),
                  assignedSecrets,
                }
              : {}),
            metricValues: metrics,
            runs,
          });
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
        "names, resource types, SSH key names, and the workflow's declared metrics. ALWAYS call " +
        "this before writing or editing workflow source: the `infra` API is generated per " +
        "organization and cannot be guessed. The default response is the fast static surface " +
        "(`create` fields are `Record<string, string>`); pass enrich:true only when you need " +
        "precise create() field unions from live provider configs — that hits provider APIs and " +
        "can be slow. Small organizations get the whole file in one call; large ones get the " +
        "global scope (the `infra` object, InfraAccounts, event, metrics, fetch) plus an index " +
        "of the named per-plugin interfaces it references — call again with typeNames to pull " +
        "just the plugins you are working with instead of the whole file. Pass workflowId to " +
        "type against an existing workflow, or pass triggerKind/metrics to preview the typings " +
        "for one you are about to create (a budget trigger types `infra.event` with the " +
        "crossing payload; only manual workflows get `infra.prompt`).",
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
        secretIds: z
          .array(z.string())
          .optional()
          .describe("Assigned workflow secret ids to include in draft typings."),
        enrich: z
          .boolean()
          .optional()
          .describe(
            "When true, hit provider APIs for precise create() field unions and live sidecar " +
              "capability flags. Slow on a cold cache — omit for the initial look at the API.",
          ),
        scope: z
          .enum(["full", "global"])
          .optional()
          .describe(
            "Omit for automatic: the full file when it is small, otherwise the global scope plus " +
              "an index of named interfaces. 'full' forces the whole file; 'global' forces the " +
              "split view.",
          ),
        typeNames: z
          .array(z.string())
          .optional()
          .describe(
            "Return only these named interface declarations (names come from the index or from " +
              "references in earlier responses, e.g. 'Account_aws'). A plugin id like 'aws' " +
              "returns every interface generated for that plugin. Overrides scope.",
          ),
      },
      risk: "read",
      permission: "workflows:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "workflows:read");
        if (denied) return denied;
        const workflowId = input["workflowId"] as string | undefined;
        if (workflowId || input["secretIds"] !== undefined) {
          const secretsDenied = await denyUnlessPermitted(auth, "secrets:read");
          if (secretsDenied) return secretsDenied;
        }
        try {
          let metrics = (input["metrics"] as MetricDef[] | undefined) ?? [];
          let assignedSecrets: Array<{ id: string; name: string }> = [];
          let triggerKind =
            (input["triggerKind"] as WorkflowTrigger["kind"] | undefined) ?? "manual";
          if (workflowId) {
            const wf = await requireWorkflow(auth.organizationId, workflowId);
            metrics = (wf.metricDefs ?? []) as MetricDef[];
            triggerKind = (wf.trigger as WorkflowTrigger).kind;
            assignedSecrets = await listAssignedWorkflowSecrets(auth.organizationId, workflowId);
          } else if (input["secretIds"] !== undefined) {
            const wanted = new Set(input["secretIds"] as string[]);
            assignedSecrets = (await listWorkflowSecrets(auth.organizationId)).filter((secret) =>
              wanted.has(secret.id),
            );
          }
          const parts = await generateWorkflowTypingsParts(auth.organizationId, {
            metrics,
            secrets: secretRefs(assignedSecrets),
            triggerKind,
            enrichCreateFields: input["enrich"] === true,
          });

          const requested = input["typeNames"] as string[] | undefined;
          if (requested && requested.length > 0) {
            const wanted = new Set<string>();
            const unknown: string[] = [];
            for (const raw of requested) {
              const matches = matchTypeName(parts.types, raw);
              if (matches.length === 0) unknown.push(raw);
              for (const m of matches) wanted.add(m.name);
            }
            if (wanted.size === 0) {
              return err(
                `No interfaces match ${unknown.join(", ")}. ` +
                  `Available: ${parts.types.map((t) => t.name).join(", ")}`,
              );
            }
            const header =
              unknown.length > 0 ? `// No interfaces match: ${unknown.join(", ")}\n\n` : "";
            const picked = parts.types.filter((t) => wanted.has(t.name));
            return okText(header + picked.map((t) => t.dts).join("\n\n"));
          }

          const scope = input["scope"] as "full" | "global" | undefined;
          if (
            scope === "full" ||
            (scope !== "global" && parts.full.length <= FULL_TYPINGS_INLINE_LIMIT)
          ) {
            return okText(parts.full);
          }
          const names = parts.types.map((t) => t.name);
          return okText(
            `${parts.global}\n` +
              `// ——— ${names.length} named interfaces omitted (full typings are ${parts.full.length} ` +
              `chars; scope: "full" returns everything) ———\n` +
              `// The declarations above reference them by name: InfraAccounts → AccountGroup_<plugin> → ` +
              `Account_<plugin> → Resource_<plugin>_<type>.\n` +
              `// Fetch only what you need by calling this tool with typeNames — a plugin id (e.g. ` +
              `"kubernetes") fetches all of that plugin's interfaces. Available:\n` +
              `// ${names.join(", ")}\n`,
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
        secretIds: z.array(z.string()).optional(),
      },
      risk: "read",
      permission: "workflows:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "workflows:read");
        if (denied) return denied;
        if (input["workflowId"] !== undefined || input["secretIds"] !== undefined) {
          const secretsDenied = await denyUnlessPermitted(auth, "secrets:read");
          if (secretsDenied) return secretsDenied;
        }
        try {
          let metrics = (input["metrics"] as MetricDef[] | undefined) ?? [];
          let assignedSecrets: Array<{ id: string; name: string }> = [];
          let triggerKind =
            (input["triggerKind"] as WorkflowTrigger["kind"] | undefined) ?? "manual";
          const workflowId = input["workflowId"] as string | undefined;
          if (workflowId) {
            const wf = await requireWorkflow(auth.organizationId, workflowId);
            metrics = (wf.metricDefs ?? []) as MetricDef[];
            triggerKind = (wf.trigger as WorkflowTrigger).kind;
            assignedSecrets = await listAssignedWorkflowSecrets(auth.organizationId, workflowId);
          } else if (input["secretIds"] !== undefined) {
            const wanted = new Set(input["secretIds"] as string[]);
            assignedSecrets = (await listWorkflowSecrets(auth.organizationId)).filter((secret) =>
              wanted.has(secret.id),
            );
          }
          const result = await checkWorkflowSource(auth.organizationId, input["source"] as string, {
            metrics,
            secrets: secretRefs(assignedSecrets),
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
        secretIds: z
          .array(z.string())
          .optional()
          .describe("Replace the reusable organization secrets assigned to this workflow."),
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
        if (workflowId || input["secretIds"] !== undefined) {
          const secretsDenied = await denyUnlessPermitted(auth, "secrets:read");
          if (secretsDenied) return secretsDenied;
        }

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
          const requestedSecretIds =
            input["secretIds"] !== undefined ? new Set(input["secretIds"] as string[]) : undefined;
          const typingSecrets = requestedSecretIds
            ? (await listWorkflowSecrets(auth.organizationId)).filter((secret) =>
                requestedSecretIds.has(secret.id),
              )
            : existing
              ? await listAssignedWorkflowSecrets(auth.organizationId, existing.id)
              : [];

          // Type-check the *resulting* workflow, not just the new source: a
          // trigger change alone can invalidate it (infra.prompt disappears for
          // automated triggers, infra.event changes shape).
          let check: Awaited<ReturnType<typeof checkWorkflowSource>> | undefined;
          if (source.trim() && !input["skipTypecheck"]) {
            check = await checkWorkflowSource(auth.organizationId, source, {
              metrics,
              secrets: secretRefs(typingSecrets),
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
            ...(input["secretIds"] !== undefined
              ? { secretIds: input["secretIds"] as string[] }
              : {}),
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

          const assignedSecrets =
            existing || input["secretIds"] !== undefined
              ? await listAssignedWorkflowSecrets(auth.organizationId, saved.id)
              : [];
          return ok({
            ...summarize(saved, true),
            secretIds: assignedSecrets.map((secret) => secret.id),
            assignedSecrets,
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
            // Closes the same gap on this surface: without it, `run_workflow`
            // would let an agent do through a workflow what the tool registry
            // refuses it directly.
            runAsUserId: auth.userId,
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
