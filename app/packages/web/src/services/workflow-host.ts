/**
 * Web/cloud implementation of the workflow {@link WorkflowHost}: it reaches
 * plugin clients through the org's encrypted accounts, persists metrics in the
 * `workflow_metrics` table, and (optionally) prompts the user over a websocket.
 *
 * The heavy lifting of mapping plugin-client methods to the sandbox's dispatch
 * operations lives in `@infrawrench/workflow-runtime`'s `buildWorkflowHost`; this
 * file only supplies the platform callbacks.
 */
import {
  buildWorkflowHost,
  type MetricValue,
  type PromptSpec,
  type WorkflowHost,
  type WorkflowPluginInfo,
} from "@infrawrench/workflow-runtime";
import { loadPlugins } from "@infrawrench/server-core/plugin-loader";
import {
  buildSshKeyFieldResolver,
  buildWorkflowSshDeps,
  enrichCreateFields,
} from "@infrawrench/server-core/workflows/runner";
import { and, eq, isNull } from "drizzle-orm";

import { db } from "@infrawrench/server-core/db/client";
import { accounts, workflowMetrics } from "@infrawrench/server-core/db/schema";

import { getClientForAccount } from "./plugin-clients";

export interface OrgWorkflowHostOptions {
  organizationId: string;
  workflowId: string;
  /** Provided for interactive (manual) runs; omitted for automated triggers. */
  prompt?: (spec: PromptSpec) => Promise<MetricValue>;
  /** Provided when storage object reads should be supported for this run. */
  readStorageObject?: (accountId: string, bucket: string, key: string) => Promise<Uint8Array>;
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
          supportsDelete: Boolean(rt.supportsDelete),
          storage: Boolean(rt.supportsStorageBrowser),
        })),
      };
      byPlugin.set(row.pluginId, entry);
    }
    entry.accounts.push({ id: row.id, pluginId: row.pluginId, displayName: row.displayName });
  }

  // Best-effort: type each createable resource's fields from the live create
  // config (cached) so `create({...})` autocompletes real keys/options.
  if (opts.enrichCreateFields) {
    await Promise.all(
      Array.from(byPlugin.values()).map((entry) => {
        const first = entry.accounts[0];
        if (!first) return Promise.resolve();
        return enrichCreateFields(entry.pluginId, entry.resourceTypes, async () => {
          const ctx = await getClientForAccount(first.id, organizationId);
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

export async function buildOrgWorkflowHost(opts: OrgWorkflowHostOptions): Promise<WorkflowHost> {
  const { organizationId, workflowId } = opts;
  return buildWorkflowHost({
    listPlugins: () => listOrgPlugins(organizationId),
    getClient: async (accountId: string) => {
      const ctx = await getClientForAccount(accountId, organizationId);
      if (!ctx) throw new Error(`Account ${accountId} not found in this organization.`);
      return ctx.client;
    },
    readStorageObject:
      opts.readStorageObject ??
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
      opts.prompt ??
      (async () => {
        throw new Error("This run is not interactive; infra.prompt() is unavailable.");
      }),
    transformCreateFields: buildSshKeyFieldResolver(organizationId, async (accountId) => {
      const ctx = await getClientForAccount(accountId, organizationId);
      return ctx ? { client: ctx.client, pluginId: ctx.account.pluginId } : null;
    }),
    ...buildWorkflowSshDeps(organizationId),
  });
}
