/**
 * Custom-graph tools — let MCP clients and the chat agent create script-defined
 * dashboard charts: sandboxed TypeScript that queries org cost data, provider
 * metrics, and external APIs, declares its own controls (selects, checkboxes,
 * buttons), and returns a render spec with its own refresh policy.
 *
 * The pairing mirrors workflows: `get_custom_graph_typings` hands back the
 * ambient `graph.d.ts`, and `write_custom_graph` type-checks source against it
 * before saving — a graph with type errors is rejected with diagnostics
 * instead of being persisted and rendering an error tile.
 *
 * Everything routes through services/custom-graphs.ts, the same module behind
 * the HTTP routes, so the two surfaces can't drift. Writes and renders are
 * paid-plan-gated there.
 */
import { z } from "zod";

import {
  CustomGraphError,
  checkCustomGraphSource,
  createCustomGraph,
  generateCustomGraphTypings,
  listCustomGraphs,
  renderOrgCustomGraph,
  requireCustomGraph,
  softDeleteCustomGraph,
  updateCustomGraph,
  type CustomGraphRow,
} from "../services/custom-graphs";
import { PlanRequiredError } from "../services/entitlements";
import { logAudit } from "../services/audit";
import { denyUnlessPermitted } from "./permissions";
import { ok, okText, err, type ToolDefinition, type ToolResult } from "./types";

function toolError(e: unknown): ToolResult {
  if (e instanceof CustomGraphError || e instanceof PlanRequiredError) return err(e.message);
  throw e;
}

function formatDiagnostics(
  diagnostics: Array<{ line: number; column: number; code: number; message: string }>,
): string {
  return diagnostics
    .slice(0, 20)
    .map((d) => `${d.line}:${d.column} TS${d.code} ${d.message}`)
    .join("\n");
}

function summarize(row: CustomGraphRow, includeSource: boolean) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(includeSource ? { source: row.source } : {}),
  };
}

const controlValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export function customGraphTools(): ToolDefinition[] {
  return [
    {
      name: "list_custom_graphs",
      title: "List custom graphs",
      description:
        "List the organization's custom graphs — script-defined dashboard charts run in a " +
        "server-side sandbox. Source is omitted; use get_custom_graph for that.",
      inputSchema: {},
      risk: "read",
      permission: "dashboards:read",
      handler: async (_input, auth) => {
        const denied = await denyUnlessPermitted(auth, "dashboards:read");
        if (denied) return denied;
        const rows = await listCustomGraphs(auth.organizationId);
        return ok(rows.map((row) => summarize(row, false)));
      },
    },

    {
      name: "get_custom_graph",
      title: "Get custom graph",
      description: "Fetch one custom graph including its full TypeScript source.",
      inputSchema: { graphId: z.string() },
      risk: "read",
      permission: "dashboards:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "dashboards:read");
        if (denied) return denied;
        try {
          const row = await requireCustomGraph(auth.organizationId, input["graphId"] as string);
          return ok(summarize(row, true));
        } catch (e) {
          return toolError(e);
        }
      },
    },

    {
      name: "get_custom_graph_typings",
      title: "Get custom graph typings",
      description:
        "Return the ambient `graph.d.ts` that custom-graph source is written against. ALWAYS " +
        "call this before writing or editing graph source — it documents the whole runtime API: " +
        "`graph.controls.*` (selects/checkboxes/buttons/inputs whose values round-trip from the " +
        "viewer), `graph.costs.query` (the org's collected spend), `graph.resources.list` and " +
        "`graph.metrics` (provider metric series), `graph.data.*` (a private key/value store), " +
        "the proxied global `fetch`, `graph.render` (chart types: line, area, stacked_bar, " +
        "multi_bar, pie, stat, table; plus refreshSeconds for auto-refresh), and a READ-ONLY " +
        "`infra.accounts` tree over this organization's real accounts — list/get resources, " +
        "resolve outputs, read logs/metrics/manifests, run SQL queries, and run SSH commands " +
        "via resource.ssh(cmd). Mutations (create/update/delete/applyManifest) are not " +
        "available in graphs, and infra.* runs with the AUTHOR's role permissions at render " +
        "time (resources:read for reads, resources:execute for SSH/SQL/KV).",
      inputSchema: {},
      risk: "read",
      permission: "dashboards:read",
      handler: async (_input, auth) => {
        const denied = await denyUnlessPermitted(auth, "dashboards:read");
        if (denied) return denied;
        return okText(await generateCustomGraphTypings(auth.organizationId));
      },
    },

    {
      name: "write_custom_graph",
      title: "Write custom graph",
      description:
        "Create a custom graph (omit graphId) or update one (pass graphId). The source is " +
        "TypeScript run in a sandbox against the global `graph` object — call " +
        "get_custom_graph_typings FIRST. The script gathers data (org costs via " +
        "graph.costs.query, provider metrics via graph.metrics, external APIs via fetch, its own " +
        "stored data via graph.data, and read-only `infra.accounts` access incl. " +
        "resource.ssh(cmd) — which runs with the SAVING USER's role permissions at render time), " +
        "declares controls whose current values it reads back synchronously, and finishes with " +
        "graph.render({ title, chart, refreshSeconds }). " +
        "Before saving, the source is type-checked and the save is REJECTED with diagnostics on " +
        "errors: read them, fix the source, and call again (set skipTypecheck to save anyway). " +
        "After saving, call render_custom_graph to verify it actually renders, then add it to a " +
        'dashboard by POSTing a widget with kind "custom_graph" and config {version:1, graphId} ' +
        "(POST /api/org/{orgId}/dashboards/widgets). Paid-plan feature. Audit-logged.",
      inputSchema: {
        graphId: z.string().optional().describe("Omit to create a new graph."),
        name: z.string().optional(),
        description: z.string().optional(),
        source: z.string().optional().describe("The TypeScript body. Top-level await is allowed."),
        skipTypecheck: z
          .boolean()
          .optional()
          .describe("Save even when the source has type errors. Use only when deliberate."),
      },
      risk: "write",
      permission: "dashboards:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "dashboards:write");
        if (denied) return denied;
        const graphId = input["graphId"] as string | undefined;
        try {
          const existing = graphId
            ? await requireCustomGraph(auth.organizationId, graphId)
            : undefined;
          const source = (input["source"] as string | undefined) ?? existing?.source ?? "";

          // Gate only the write the caller is actually making: a metadata-only
          // update must not re-litigate stored source that was deliberately
          // saved with skipTypecheck.
          let check: Awaited<ReturnType<typeof checkCustomGraphSource>> | undefined;
          if (input["source"] !== undefined && source.trim() && !input["skipTypecheck"]) {
            check = await checkCustomGraphSource(auth.organizationId, source);
            if (check.hasErrors) {
              return err(
                `Not saved — the graph source has type errors:\n${formatDiagnostics(check.diagnostics)}\n\n` +
                  "Call get_custom_graph_typings to see the `graph` API, fix the source, and " +
                  "call write_custom_graph again.",
              );
            }
          }

          const body = {
            ...(input["name"] !== undefined ? { name: input["name"] as string } : {}),
            ...(input["description"] !== undefined
              ? { description: input["description"] as string }
              : {}),
            ...(input["source"] !== undefined ? { source } : {}),
          };
          const saved = existing
            ? await updateCustomGraph(auth.organizationId, existing.id, body, auth.userId)
            : await createCustomGraph(auth.organizationId, body, auth.userId);

          void logAudit({
            organizationId: auth.organizationId,
            userId: auth.userId,
            action: existing ? "custom_graph.update" : "custom_graph.create",
            entityType: "custom_graph",
            entityId: saved.id,
            metadata: { name: saved.name, source: auth.source },
          });

          return ok({
            ...summarize(saved, true),
            ...(check?.degraded
              ? { note: "Type checking was unavailable; only syntax was checked." }
              : {}),
          });
        } catch (e) {
          return toolError(e);
        }
      },
    },

    {
      name: "render_custom_graph",
      title: "Render custom graph",
      description:
        "Run a custom graph's script in the sandbox and return its render result: the spec " +
        "(chart, controls, refreshSeconds) plus run logs and any error. Use it to verify a graph " +
        "you just wrote, passing control values or a button id to exercise interactions. " +
        "Read-only over the org (costs, metrics, listings) plus the graph's own data store.",
      inputSchema: {
        graphId: z.string(),
        controls: z
          .record(z.string(), controlValueSchema)
          .optional()
          .describe("Control values keyed by control id, as a viewer would have chosen them."),
        button: z.string().optional().describe("Id of a declared button to simulate pressing."),
        trigger: z
          .enum(["manual", "refresh", "interaction"])
          .optional()
          .describe(
            'What the script sees as graph.event.kind — pass "refresh" to test its auto-refresh path.',
          ),
      },
      risk: "write",
      permission: "dashboards:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "dashboards:read");
        if (denied) return denied;
        try {
          const controls = input["controls"] as
            Record<string, string | number | boolean> | undefined;
          const button = input["button"] as string | undefined;
          const trigger = input["trigger"] as "manual" | "refresh" | "interaction" | undefined;
          return ok(
            await renderOrgCustomGraph(auth.organizationId, input["graphId"] as string, {
              ...(controls ? { controls } : {}),
              ...(button ? { button } : {}),
              ...(trigger ? { trigger } : {}),
            }),
          );
        } catch (e) {
          return toolError(e);
        }
      },
    },

    {
      name: "delete_custom_graph",
      title: "Delete custom graph",
      description:
        "Delete a custom graph (soft delete) along with every dashboard card showing it, and its " +
        "stored data. Audit-logged. The chat surface confirms with the user before invoking.",
      inputSchema: { graphId: z.string() },
      risk: "destructive",
      permission: "dashboards:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "dashboards:write");
        if (denied) return denied;
        const id = input["graphId"] as string;
        try {
          await softDeleteCustomGraph(auth.organizationId, id);
          void logAudit({
            organizationId: auth.organizationId,
            userId: auth.userId,
            action: "custom_graph.delete",
            entityType: "custom_graph",
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
