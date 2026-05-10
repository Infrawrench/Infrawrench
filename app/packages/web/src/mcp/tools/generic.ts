import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { accounts, resources, secretFieldStates } from "../../db/schema";
import { loadPlugins, getPlugin } from "../../plugins/loader";
import { getClientForAccount, getClientForResource } from "../../services/plugin-clients";
import { loadSecretStatesForResource } from "../../services/secret-states";
import { encrypt } from "../../services/encryption";
import { logAudit } from "../../services/audit";
import { normalizeResourceCreateResult } from "@infrawrench/plugin-base";
import type { McpAuthContext } from "../auth";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function err(message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

export function registerGenericTools(server: McpServer, auth: McpAuthContext): void {
  const orgId = auth.organizationId;

  server.registerTool(
    "list_plugins",
    {
      title: "List plugins",
      description:
        "List all installed Infrawrench plugins (cloud providers, databases, etc.) and their credential field schemas.",
      inputSchema: {},
    },
    async () => {
      const plugins = await loadPlugins();
      return ok(
        plugins.map((p) => ({
          id: p.plugin.manifest.id,
          displayName: p.plugin.manifest.displayName,
          description: p.plugin.manifest.description,
          credentialFields: p.plugin.manifest.credentialFields.map((f) => ({
            key: f.key,
            label: f.label,
            sensitive: f.sensitive,
          })),
        })),
      );
    },
  );

  server.registerTool(
    "list_resource_types",
    {
      title: "List resource types",
      description:
        "List the resource types defined by a plugin, including their fields, outputs, and capability flags (supportsCreate, supportsDelete, supportsMetrics).",
      inputSchema: {
        pluginId: z.string().describe("Plugin id, e.g. 'digitalocean', 'postgres'"),
      },
    },
    async ({ pluginId }) => {
      const loaded = await getPlugin(pluginId);
      if (!loaded) return err(`Plugin not found: ${pluginId}`);
      return ok(
        loaded.plugin.resourceTypes.map((t) => ({
          id: t.id,
          displayName: t.displayName,
          pluralDisplayName: t.pluralDisplayName,
          description: t.description,
          parentTypeId: t.parentTypeId ?? null,
          supportsCreate: !!t.supportsCreate,
          supportsDelete: t.supportsDelete !== false,
          supportsMetrics: !!t.supportsMetrics,
          fields: t.fields.map((f) => ({
            key: f.key,
            label: f.label,
            kind: f.kind,
            required: f.required,
            description: f.description,
            enumValues: f.enumValues,
          })),
          outputs: t.outputs.map((o) => ({
            key: o.key,
            label: o.label,
            sensitive: o.sensitive,
            description: o.description,
          })),
        })),
      );
    },
  );

  server.registerTool(
    "list_accounts",
    {
      title: "List accounts",
      description: "List all connected accounts (credential sets) in the caller's organization.",
      inputSchema: {},
    },
    async () => {
      const rows = await db
        .select({
          id: accounts.id,
          pluginId: accounts.pluginId,
          displayName: accounts.displayName,
          createdAt: accounts.createdAt,
        })
        .from(accounts)
        .where(and(eq(accounts.organizationId, orgId), isNull(accounts.deletedAt)));
      return ok(rows);
    },
  );

  server.registerTool(
    "search_resources",
    {
      title: "Search resources",
      description:
        "Substring-match resources across every connected account. Matches against resource display name, account name, plugin name, and resource-type label. Returns up to 50 results.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Substring to match. Leave empty to list everything (capped at 50)."),
      },
    },
    async ({ query }) => {
      const q = (query ?? "").toLowerCase().trim();

      const allResources = await db
        .select({
          id: resources.id,
          pluginId: resources.pluginId,
          resourceTypeId: resources.resourceTypeId,
          accountId: resources.accountId,
          displayName: resources.displayName,
        })
        .from(resources)
        .where(and(eq(resources.organizationId, orgId), isNull(resources.deletedAt)));

      const allAccounts = await db
        .select({
          id: accounts.id,
          displayName: accounts.displayName,
          pluginId: accounts.pluginId,
        })
        .from(accounts)
        .where(and(eq(accounts.organizationId, orgId), isNull(accounts.deletedAt)));
      const accountMap = new Map(allAccounts.map((a) => [a.id, a]));

      const pluginCache = new Map<
        string,
        { displayName: string; resourceTypes: Map<string, string> }
      >();

      const results: Array<{
        id: string;
        pluginId: string;
        pluginDisplayName: string;
        resourceTypeId: string;
        resourceTypeLabel: string;
        accountId: string;
        accountName: string;
        displayName: string;
      }> = [];
      for (const r of allResources) {
        let meta = pluginCache.get(r.pluginId);
        if (!meta) {
          const loaded = await getPlugin(r.pluginId);
          if (loaded) {
            meta = {
              displayName: loaded.plugin.manifest.displayName,
              resourceTypes: new Map(
                loaded.plugin.resourceTypes.map((rt) => [rt.id, rt.displayName]),
              ),
            };
          } else {
            meta = { displayName: r.pluginId, resourceTypes: new Map() };
          }
          pluginCache.set(r.pluginId, meta);
        }
        const account = accountMap.get(r.accountId);
        const accountName = account?.displayName ?? "";
        const resourceTypeLabel = meta.resourceTypes.get(r.resourceTypeId) ?? r.resourceTypeId;

        if (q) {
          const hay =
            `${r.displayName} ${accountName} ${meta.displayName} ${resourceTypeLabel}`.toLowerCase();
          if (!hay.includes(q)) continue;
        }

        results.push({
          id: r.id,
          pluginId: r.pluginId,
          pluginDisplayName: meta.displayName,
          resourceTypeId: r.resourceTypeId,
          resourceTypeLabel,
          accountId: r.accountId,
          accountName,
          displayName: r.displayName,
        });

        if (results.length >= 50) break;
      }
      return ok(results);
    },
  );

  const resourceTargetSchema = {
    pluginId: z.string(),
    accountId: z.string(),
    resourceTypeId: z.string(),
    resourceId: z.string(),
    parentResourceId: z.string().optional(),
  };

  server.registerTool(
    "list_resources",
    {
      title: "List resources",
      description: "List live resources of a given type for an account.",
      inputSchema: {
        pluginId: z.string(),
        accountId: z.string(),
        resourceTypeId: z.string(),
        parentResourceId: z.string().optional(),
      },
    },
    async ({ pluginId, accountId, resourceTypeId, parentResourceId }) => {
      const ctx = await getClientForResource(pluginId, accountId, orgId, parentResourceId);
      if (!ctx) return err("Account or peer resource not found");
      const list = await ctx.client.listResources(resourceTypeId, accountId);
      return ok(
        list.map((r) => ({
          id: r.id,
          displayName: r.displayName,
          resourceTypeId: r.resourceTypeId,
          pluginId: r.pluginId,
          accountId: r.accountId,
          externalId: r.externalId,
          fields: r.fields,
        })),
      );
    },
  );

  server.registerTool(
    "get_resource",
    {
      title: "Get resource",
      description:
        "Fetch a single resource's full state: non-secret fields and resolved outputs. Use get_resource_outputs to fetch sensitive outputs explicitly.",
      inputSchema: resourceTargetSchema,
    },
    async ({ pluginId, accountId, resourceTypeId, resourceId, parentResourceId }) => {
      const ctx = await getClientForResource(pluginId, accountId, orgId, parentResourceId);
      if (!ctx) return err("Account or peer resource not found");
      try {
        const inst = await ctx.client.getResource(resourceTypeId, resourceId, accountId);
        return ok({
          id: inst.id,
          displayName: inst.displayName,
          resourceTypeId: inst.resourceTypeId,
          pluginId: inst.pluginId,
          accountId: inst.accountId,
          externalId: inst.externalId,
          parentResourceId: inst.parentResourceId,
          fields: inst.fields,
          resolvedOutputs: inst.resolvedOutputs,
          createdAt: inst.createdAt,
          updatedAt: inst.updatedAt,
        });
      } catch (e) {
        return err(e instanceof Error ? e.message : "Failed to fetch resource");
      }
    },
  );

  server.registerTool(
    "get_resource_outputs",
    {
      title: "Get resource outputs",
      description:
        "Resolve a list of output keys for a resource (e.g. connectionString, ipv4). Outputs marked sensitive are returned in plaintext — handle with care.",
      inputSchema: {
        ...resourceTargetSchema,
        outputKeys: z
          .array(z.string())
          .optional()
          .describe("Output keys to resolve. Defaults to every output declared on the type."),
      },
    },
    async ({ pluginId, accountId, resourceTypeId, resourceId, parentResourceId, outputKeys }) => {
      const ctx = await getClientForResource(pluginId, accountId, orgId, parentResourceId);
      if (!ctx) return err("Account or peer resource not found");
      const typeDef = ctx.plugin.resourceTypes.find((t) => t.id === resourceTypeId);
      if (!typeDef) return err(`Resource type not found: ${resourceTypeId}`);
      const keys = outputKeys ?? typeDef.outputs.map((o) => o.key);
      const out: Record<string, string | { error: string }> = {};
      for (const key of keys) {
        try {
          out[key] = await ctx.client.resolveOutput(resourceTypeId, resourceId, key, accountId);
        } catch (e) {
          out[key] = { error: e instanceof Error ? e.message : "resolveOutput failed" };
        }
      }
      return ok(out);
    },
  );

  server.registerTool(
    "get_resource_inputs",
    {
      title: "Get resource inputs",
      description:
        "Return the resource's user-supplied inputs: non-secret fields plus the secret-field bindings (literal vs output-ref) — secret values are NOT included.",
      inputSchema: {
        resourceId: z.string(),
      },
    },
    async ({ resourceId }) => {
      const [row] = await db
        .select()
        .from(resources)
        .where(
          and(
            eq(resources.id, resourceId),
            eq(resources.organizationId, orgId),
            isNull(resources.deletedAt),
          ),
        )
        .limit(1);
      if (!row) return err("Resource not found");

      const secretRows = await db
        .select({
          fieldKey: secretFieldStates.fieldKey,
          resolutionKind: secretFieldStates.resolutionKind,
          sourcePluginId: secretFieldStates.sourcePluginId,
          sourceResourceTypeId: secretFieldStates.sourceResourceTypeId,
          sourceResourceId: secretFieldStates.sourceResourceId,
          sourceAccountId: secretFieldStates.sourceAccountId,
          sourceOutputKey: secretFieldStates.sourceOutputKey,
        })
        .from(secretFieldStates)
        .where(eq(secretFieldStates.resourceId, resourceId));

      return ok({
        id: row.id,
        displayName: row.displayName,
        pluginId: row.pluginId,
        resourceTypeId: row.resourceTypeId,
        accountId: row.accountId,
        fields: row.fieldsJson ?? {},
        secretBindings: secretRows.map((s) => ({
          fieldKey: s.fieldKey,
          kind: s.resolutionKind,
          ...(s.resolutionKind === "output-ref" && {
            sourcePluginId: s.sourcePluginId,
            sourceResourceTypeId: s.sourceResourceTypeId,
            sourceResourceId: s.sourceResourceId,
            sourceAccountId: s.sourceAccountId,
            sourceOutputKey: s.sourceOutputKey,
          }),
        })),
      });
    },
  );

  server.registerTool(
    "get_resource_stats",
    {
      title: "Get resource stats",
      description: "Fetch dashboard-style key/value stats for a resource (when supported).",
      inputSchema: resourceTargetSchema,
    },
    async ({ pluginId, accountId, resourceTypeId, resourceId, parentResourceId }) => {
      const ctx = await getClientForResource(pluginId, accountId, orgId, parentResourceId);
      if (!ctx) return err("Account or peer resource not found");
      if (!ctx.client.fetchDashboardStats) return err("Plugin does not support dashboard stats");
      try {
        const stats = await ctx.client.fetchDashboardStats(resourceTypeId, resourceId, accountId);
        return ok(stats);
      } catch (e) {
        return err(e instanceof Error ? e.message : "Failed to fetch stats");
      }
    },
  );

  server.registerTool(
    "get_resource_metrics",
    {
      title: "Get resource metrics",
      description:
        "Fetch time-series metrics (CPU, memory, request rate, etc.) for a resource. Provide startMs/endMs to scope the range; otherwise the plugin picks a default window.",
      inputSchema: {
        ...resourceTargetSchema,
        startMs: z.number().int().optional(),
        endMs: z.number().int().optional(),
      },
    },
    async ({
      pluginId,
      accountId,
      resourceTypeId,
      resourceId,
      parentResourceId,
      startMs,
      endMs,
    }) => {
      const ctx = await getClientForResource(pluginId, accountId, orgId, parentResourceId);
      if (!ctx) return err("Account or peer resource not found");
      if (!ctx.client.fetchMetricSeries) return err("Plugin does not support metrics");
      const range = startMs != null && endMs != null ? { startMs, endMs } : undefined;
      try {
        const series = await ctx.client.fetchMetricSeries(
          resourceTypeId,
          resourceId,
          accountId,
          range,
        );
        return ok({ series });
      } catch (e) {
        return err(e instanceof Error ? e.message : "Failed to fetch metrics");
      }
    },
  );

  server.registerTool(
    "describe_resource",
    {
      title: "Describe resource",
      description:
        "Plain-text describe summary for a resource (status, events, related objects), kubectl-describe style. Only available for plugins that implement it.",
      inputSchema: resourceTargetSchema,
    },
    async ({ pluginId, accountId, resourceTypeId, resourceId, parentResourceId }) => {
      const ctx = await getClientForResource(pluginId, accountId, orgId, parentResourceId);
      if (!ctx) return err("Account or peer resource not found");
      if (!ctx.client.describeResource) return err("Plugin does not support describe");
      const text = await ctx.client.describeResource(resourceTypeId, resourceId, accountId);
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "create_resource",
    {
      title: "Create resource",
      description:
        "Generic resource creation. Use list_resource_types to see required `fields` for a given (pluginId, resourceTypeId). Audit-logged.",
      inputSchema: {
        pluginId: z.string(),
        accountId: z.string(),
        resourceTypeId: z.string(),
        fields: z
          .record(z.string(), z.string())
          .describe("Form-style key/value pairs matching the type's field definitions."),
        parentResourceId: z.string().optional(),
      },
    },
    async ({ pluginId, accountId, resourceTypeId, fields, parentResourceId }) => {
      const ctx = await getClientForResource(pluginId, accountId, orgId, parentResourceId);
      if (!ctx) return err("Account or peer resource not found");
      if (!ctx.client.createResource) return err("Plugin does not support creation");

      let createReturn;
      try {
        createReturn = await ctx.client.createResource(
          resourceTypeId,
          accountId,
          fields,
          parentResourceId,
        );
      } catch (e) {
        return err(e instanceof Error ? e.message : "Resource creation failed");
      }

      const { resource: created, warnings } = normalizeResourceCreateResult(createReturn);

      if (ctx.account.pluginId === pluginId) {
        try {
          await db
            .insert(resources)
            .values({
              id: created.id,
              organizationId: orgId,
              pluginId,
              resourceTypeId,
              accountId,
              displayName: created.displayName,
              externalId: created.externalId ?? null,
              fieldsJson: created.fields ?? {},
              outputsJson: created.resolvedOutputs ?? {},
              parentResourceId: created.parentResourceId ?? null,
            })
            .onConflictDoUpdate({
              target: resources.id,
              set: {
                displayName: created.displayName,
                fieldsJson: created.fields ?? {},
                outputsJson: created.resolvedOutputs ?? {},
                deletedAt: null,
                updatedAt: new Date(),
              },
            });

          for (const state of created.secretStates ?? []) {
            if (state.resolution.kind !== "plaintext") continue;
            const { ciphertext, iv } = await encrypt(state.resolution.value);
            await db
              .insert(secretFieldStates)
              .values({
                id: uuidv4(),
                resourceId: created.id,
                fieldKey: state.fieldKey,
                resolutionKind: "literal",
                encryptedValue: ciphertext,
                valueIv: iv,
              })
              .onConflictDoUpdate({
                target: [secretFieldStates.resourceId, secretFieldStates.fieldKey],
                set: {
                  resolutionKind: "literal",
                  encryptedValue: ciphertext,
                  valueIv: iv,
                  sourcePluginId: null,
                  sourceResourceTypeId: null,
                  sourceResourceId: null,
                  sourceAccountId: null,
                  sourceOutputKey: null,
                  cachedEncryptedValue: null,
                  cachedValueIv: null,
                  cachedAt: null,
                  updatedAt: new Date(),
                },
              });
          }
        } catch {
          // Non-critical; the next sync will reconcile.
        }
      }

      void logAudit({
        organizationId: orgId,
        userId: auth.userId,
        action: "resource.create",
        entityType: "resource",
        entityId: created.id,
        metadata: { pluginId, resourceTypeId, source: "mcp" },
      });

      return ok({ id: created.id, displayName: created.displayName, warnings });
    },
  );

  server.registerTool(
    "delete_resource",
    {
      title: "Delete resource",
      description:
        "Permanently delete a resource. Audit-logged. The MCP client should confirm with the user first.",
      inputSchema: resourceTargetSchema,
    },
    async ({ pluginId, accountId, resourceTypeId, resourceId, parentResourceId }) => {
      const ctx = await getClientForResource(pluginId, accountId, orgId, parentResourceId);
      if (!ctx) return err("Account or peer resource not found");
      if (!ctx.client.deleteResource) return err("Plugin does not support deletion");
      try {
        await ctx.client.deleteResource(resourceTypeId, resourceId, accountId);
      } catch (e) {
        return err(e instanceof Error ? e.message : "Deletion failed");
      }
      void logAudit({
        organizationId: orgId,
        userId: auth.userId,
        action: "resource.delete",
        entityType: "resource",
        entityId: resourceId,
        metadata: { pluginId, resourceTypeId, source: "mcp" },
      });
      return ok({ ok: true });
    },
  );

  server.registerTool(
    "invoke_action",
    {
      title: "Invoke resource action",
      description:
        "Run a plugin-defined action against a resource (start/stop/restart/etc.). actionId is plugin-specific — discover via the resource's detail schema.",
      inputSchema: {
        ...resourceTargetSchema,
        actionId: z.string(),
      },
    },
    async ({ pluginId, accountId, resourceTypeId, resourceId, parentResourceId, actionId }) => {
      const ctx = await getClientForResource(pluginId, accountId, orgId, parentResourceId);
      if (!ctx) return err("Account or peer resource not found");
      if (!ctx.client.invokeAction) return err("Plugin does not support actions");
      try {
        await ctx.client.invokeAction(resourceTypeId, resourceId, actionId, accountId);
      } catch (e) {
        return err(e instanceof Error ? e.message : "Action failed");
      }
      void logAudit({
        organizationId: orgId,
        userId: auth.userId,
        action: "resource.invoke_action",
        entityType: "resource",
        entityId: resourceId,
        metadata: { pluginId, resourceTypeId, actionId, source: "mcp" },
      });
      return ok({ ok: true });
    },
  );

  server.registerTool(
    "get_manifest",
    {
      title: "Get resource manifest",
      description:
        "Read the full manifest (YAML/JSON) for a resource. Edits go through apply_manifest.",
      inputSchema: resourceTargetSchema,
    },
    async ({ pluginId, accountId, resourceTypeId: _t, resourceId, parentResourceId }) => {
      const ctx = await getClientForResource(pluginId, accountId, orgId, parentResourceId);
      if (!ctx) return err("Account or peer resource not found");
      if (!ctx.client.getManifest) return err("Plugin does not support manifest viewing");
      const manifest = await ctx.client.getManifest(resourceId, accountId);
      return { content: [{ type: "text", text: manifest }] };
    },
  );

  server.registerTool(
    "apply_manifest",
    {
      title: "Apply resource manifest",
      description:
        "Apply an updated manifest (YAML/JSON) to a resource — primary edit path for k8s, postgres, and similar plugins. Audit-logged.",
      inputSchema: {
        ...resourceTargetSchema,
        manifest: z.string(),
      },
    },
    async ({ pluginId, accountId, resourceTypeId, resourceId, parentResourceId, manifest }) => {
      const ctx = await getClientForResource(pluginId, accountId, orgId, parentResourceId);
      if (!ctx) return err("Account or peer resource not found");
      if (!ctx.client.applyManifest) return err("Plugin does not support manifest editing");
      try {
        await ctx.client.applyManifest(resourceId, accountId, manifest);
      } catch (e) {
        return err(e instanceof Error ? e.message : "applyManifest failed");
      }
      void logAudit({
        organizationId: orgId,
        userId: auth.userId,
        action: "resource.apply_manifest",
        entityType: "resource",
        entityId: resourceId,
        metadata: { pluginId, resourceTypeId, source: "mcp" },
      });
      return ok({ ok: true });
    },
  );
}
