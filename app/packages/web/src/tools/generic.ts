import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { accounts, resources, secretFieldStates } from "../db/schema";
import { loadPlugins, getPlugin } from "../plugins/loader";
import {
  getClientForAccount,
  getClientForResource,
  filterVisiblePeerIntegrations,
} from "../services/plugin-clients";
import { encrypt, buildAad } from "../services/encryption";
import { resolveStoredSshPublicKey } from "./ssh-key-lookup";
import { logAudit } from "../services/audit";
import {
  evaluatePeerIntegrationUnreachable,
  normalizeResourceCreateResult,
} from "@infrawrench/plugin-base";
import { ok, okText, err, type ToolDefinition } from "./types";

const parentResourceIdField = z
  .string()
  .optional()
  .describe(
    "For sidecar (peer plugin) targets only: the id of the parent resource (managed cluster / " +
      "database) whose outputs provide the sidecar's credentials. See list_resource_sidecars.",
  );

const resourceTargetSchema = {
  pluginId: z.string(),
  accountId: z.string(),
  resourceTypeId: z.string(),
  resourceId: z.string(),
  parentResourceId: parentResourceIdField,
};

export function genericTools(): ToolDefinition[] {
  return [
    {
      name: "list_plugins",
      title: "List plugins",
      description:
        "List all installed Infrawrench plugins (cloud providers, databases, etc.) and their credential field schemas.",
      inputSchema: {},
      risk: "read",
      handler: async () => {
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
    },

    {
      name: "list_resource_types",
      title: "List resource types",
      description:
        "List the resource types defined by a plugin, including their fields, outputs, and capability flags (supportsCreate, supportsDelete, supportsMetrics).",
      inputSchema: {
        pluginId: z.string().describe("Plugin id, e.g. 'digitalocean', 'postgres'"),
      },
      risk: "read",
      handler: async (input) => {
        const pluginId = input["pluginId"] as string;
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
    },

    {
      name: "list_accounts",
      title: "List accounts",
      description: "List all connected accounts (credential sets) in the caller's organization.",
      inputSchema: {},
      risk: "read",
      handler: async (_input, auth) => {
        const rows = await db
          .select({
            id: accounts.id,
            pluginId: accounts.pluginId,
            displayName: accounts.displayName,
            createdAt: accounts.createdAt,
          })
          .from(accounts)
          .where(and(eq(accounts.organizationId, auth.organizationId), isNull(accounts.deletedAt)));
        return ok(rows);
      },
    },

    {
      name: "search_resources",
      title: "Search resources",
      description:
        "Substring-match resources across every connected account. Matches against resource display name, account name, plugin name, and resource-type label. Returns up to 50 results.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Substring to match. Leave empty to list everything (capped at 50)."),
      },
      risk: "read",
      handler: async (input, auth) => {
        const orgId = auth.organizationId;
        const q = ((input["query"] as string | undefined) ?? "").toLowerCase().trim();

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
    },

    {
      name: "list_resource_sidecars",
      title: "List resource sidecars",
      description:
        "Discover the sidecar (peer plugin) integrations a resource exposes. Managed Kubernetes " +
        "clusters (DOKS, EKS, GKE, AKS, Kapsule, …) expose the 'kubernetes' plugin via their " +
        "kubeconfig; managed databases expose 'postgres' / 'mysql' / 'redis' / 'mongodb' via " +
        "their connection string. Returns each sidecar's pluginId and resource types. To operate " +
        'inside a sidecar ("what is running in my cluster?"), call list_resources / ' +
        "get_resource / describe_resource / invoke_action with pluginId = the sidecar's " +
        "pluginId, the same accountId, and parentResourceId = this resource's id.",
      inputSchema: {
        accountId: z.string(),
        resourceId: z.string().describe("The parent resource id (the cluster / database)"),
        resourceTypeId: z
          .string()
          .optional()
          .describe("The parent's resource type id, if known — skips a lookup"),
      },
      risk: "read",
      handler: async (input, auth) => {
        const { accountId, resourceId } = input as { accountId: string; resourceId: string };
        const ctx = await getClientForAccount(accountId, auth.organizationId);
        if (!ctx) return err("Account not found");

        // Resolve the parent's resource type: explicit input → synced row →
        // live probe across the plugin's peer-declaring types.
        let resourceTypeId = input["resourceTypeId"] as string | undefined;
        let storedFields: Record<string, unknown> | undefined;
        if (!resourceTypeId) {
          const [row] = await db
            .select({ resourceTypeId: resources.resourceTypeId, fieldsJson: resources.fieldsJson })
            .from(resources)
            .where(
              and(
                eq(resources.id, resourceId),
                eq(resources.organizationId, auth.organizationId),
                isNull(resources.deletedAt),
              ),
            )
            .limit(1);
          resourceTypeId = row?.resourceTypeId;
          storedFields = (row?.fieldsJson as Record<string, unknown> | null) ?? undefined;
        }

        let inst: Awaited<ReturnType<typeof ctx.client.getResource>> | null = null;
        if (resourceTypeId) {
          inst = await ctx.client
            .getResource(resourceTypeId, resourceId, accountId)
            .catch(() => null);
        } else {
          for (const typeDef of ctx.plugin.resourceTypes) {
            if (!typeDef.peerIntegrations?.length) continue;
            inst = await ctx.client
              .getResource(typeDef.id, resourceId, accountId)
              .catch(() => null);
            if (inst) {
              resourceTypeId = typeDef.id;
              break;
            }
          }
        }
        if (!resourceTypeId) {
          return err(
            "Could not resolve the resource's type — pass resourceTypeId explicitly (see list_resources / search_resources)",
          );
        }
        const typeDef = ctx.plugin.resourceTypes.find((t) => t.id === resourceTypeId);
        if (!typeDef) return err(`Unknown resource type: ${resourceTypeId}`);

        const integrations = typeDef.peerIntegrations ?? [];
        if (integrations.length === 0) {
          return ok({
            resourceId,
            resourceTypeId,
            sidecars: [],
            note: `Resource type ${resourceTypeId} declares no sidecar integrations.`,
          });
        }

        const fields = inst?.fields ?? storedFields;
        const visible = filterVisiblePeerIntegrations(integrations, fields);
        const sidecars = await Promise.all(
          visible.map(async (integration) => {
            const unreachable = evaluatePeerIntegrationUnreachable(integration, fields);
            const peer = await getPlugin(integration.pluginId);
            return {
              pluginId: integration.pluginId,
              pluginDisplayName: peer?.plugin.manifest.displayName ?? integration.pluginId,
              tabLabel: integration.tabLabel,
              ...(unreachable ? { unreachable } : {}),
              resourceTypes:
                peer?.plugin.resourceTypes.map((rt) => ({
                  id: rt.id,
                  displayName: rt.displayName,
                  supportsCreate: !!rt.supportsCreate,
                })) ?? [],
            };
          }),
        );

        return ok({
          resourceId,
          resourceTypeId,
          sidecars,
          usage:
            "Call list_resources { pluginId: <sidecar pluginId>, accountId, resourceTypeId: " +
            `<sidecar resource type>, parentResourceId: "${resourceId}" }. The same ` +
            "parentResourceId pattern works for get_resource, describe_resource, invoke_action, " +
            "apply_manifest, and the per-plugin create tools.",
        });
      },
    },

    {
      name: "list_resources",
      title: "List resources",
      description:
        "List live resources of a given type for an account. Also works inside sidecars: to see " +
        "what's running in a managed Kubernetes cluster (DOKS, EKS, GKE, …), pass pluginId " +
        "'kubernetes', the cluster's accountId, a kubernetes resourceTypeId (e.g. " +
        "'k8s-deployment', 'k8s-pod' — see list_resource_types), and parentResourceId = the " +
        "cluster's resource id. Same pattern for managed databases (postgres/mysql/redis/mongodb).",
      inputSchema: {
        pluginId: z.string(),
        accountId: z.string(),
        resourceTypeId: z.string(),
        parentResourceId: parentResourceIdField,
      },
      risk: "read",
      handler: async (input, auth) => {
        const { pluginId, accountId, resourceTypeId, parentResourceId } = input as {
          pluginId: string;
          accountId: string;
          resourceTypeId: string;
          parentResourceId?: string;
        };
        const ctx = await getClientForResource(
          pluginId,
          accountId,
          auth.organizationId,
          parentResourceId,
        );
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
    },

    {
      name: "get_resource",
      title: "Get resource",
      description:
        "Fetch a single resource's full state: non-secret fields and resolved outputs. Use get_resource_outputs to fetch sensitive outputs explicitly.",
      inputSchema: resourceTargetSchema,
      risk: "read",
      handler: async (input, auth) => {
        const { pluginId, accountId, resourceTypeId, resourceId, parentResourceId } = input as {
          pluginId: string;
          accountId: string;
          resourceTypeId: string;
          resourceId: string;
          parentResourceId?: string;
        };
        const ctx = await getClientForResource(
          pluginId,
          accountId,
          auth.organizationId,
          parentResourceId,
        );
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
    },

    {
      name: "get_resource_outputs",
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
      risk: "read",
      handler: async (input, auth) => {
        const { pluginId, accountId, resourceTypeId, resourceId, parentResourceId, outputKeys } =
          input as {
            pluginId: string;
            accountId: string;
            resourceTypeId: string;
            resourceId: string;
            parentResourceId?: string;
            outputKeys?: string[];
          };
        const ctx = await getClientForResource(
          pluginId,
          accountId,
          auth.organizationId,
          parentResourceId,
        );
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
    },

    {
      name: "get_resource_inputs",
      title: "Get resource inputs",
      description:
        "Return the resource's user-supplied inputs: non-secret fields plus the secret-field bindings (literal vs output-ref) — secret values are NOT included.",
      inputSchema: {
        resourceId: z.string(),
      },
      risk: "read",
      handler: async (input, auth) => {
        const resourceId = input["resourceId"] as string;
        const [row] = await db
          .select()
          .from(resources)
          .where(
            and(
              eq(resources.id, resourceId),
              eq(resources.organizationId, auth.organizationId),
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
    },

    {
      name: "get_resource_stats",
      title: "Get resource stats",
      description: "Fetch dashboard-style key/value stats for a resource (when supported).",
      inputSchema: resourceTargetSchema,
      risk: "read",
      handler: async (input, auth) => {
        const { pluginId, accountId, resourceTypeId, resourceId, parentResourceId } = input as {
          pluginId: string;
          accountId: string;
          resourceTypeId: string;
          resourceId: string;
          parentResourceId?: string;
        };
        const ctx = await getClientForResource(
          pluginId,
          accountId,
          auth.organizationId,
          parentResourceId,
        );
        if (!ctx) return err("Account or peer resource not found");
        if (!ctx.client.fetchDashboardStats) return err("Plugin does not support dashboard stats");
        try {
          const stats = await ctx.client.fetchDashboardStats(resourceTypeId, resourceId, accountId);
          return ok(stats);
        } catch (e) {
          return err(e instanceof Error ? e.message : "Failed to fetch stats");
        }
      },
    },

    {
      name: "get_resource_metrics",
      title: "Get resource metrics",
      description:
        "Fetch time-series metrics (CPU, memory, request rate, etc.) for a resource. Provide startMs/endMs to scope the range; otherwise the plugin picks a default window.",
      inputSchema: {
        ...resourceTargetSchema,
        startMs: z.number().int().optional(),
        endMs: z.number().int().optional(),
      },
      risk: "read",
      handler: async (input, auth) => {
        const {
          pluginId,
          accountId,
          resourceTypeId,
          resourceId,
          parentResourceId,
          startMs,
          endMs,
        } = input as {
          pluginId: string;
          accountId: string;
          resourceTypeId: string;
          resourceId: string;
          parentResourceId?: string;
          startMs?: number;
          endMs?: number;
        };
        const ctx = await getClientForResource(
          pluginId,
          accountId,
          auth.organizationId,
          parentResourceId,
        );
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
    },

    {
      name: "describe_resource",
      title: "Describe resource",
      description:
        "Plain-text describe summary for a resource (status, events, related objects), kubectl-describe style. Only available for plugins that implement it.",
      inputSchema: resourceTargetSchema,
      risk: "read",
      handler: async (input, auth) => {
        const { pluginId, accountId, resourceTypeId, resourceId, parentResourceId } = input as {
          pluginId: string;
          accountId: string;
          resourceTypeId: string;
          resourceId: string;
          parentResourceId?: string;
        };
        const ctx = await getClientForResource(
          pluginId,
          accountId,
          auth.organizationId,
          parentResourceId,
        );
        if (!ctx) return err("Account or peer resource not found");
        if (!ctx.client.describeResource) return err("Plugin does not support describe");
        const text = await ctx.client.describeResource(resourceTypeId, resourceId, accountId);
        return okText(text);
      },
    },

    {
      name: "create_resource",
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
        parentResourceId: parentResourceIdField,
        sshKeyId: z
          .string()
          .optional()
          .describe(
            "Stored org SSH key id (see list_ssh_keys) to install for SSH access. Only for " +
              "resource types that accept an SSH key at create time (VM types) — its public " +
              "key is injected into the type's SSH-key field.",
          ),
      },
      risk: "write",
      handler: async (input, auth) => {
        const { pluginId, accountId, resourceTypeId, parentResourceId, sshKeyId } = input as {
          pluginId: string;
          accountId: string;
          resourceTypeId: string;
          fields: Record<string, string>;
          parentResourceId?: string;
          sshKeyId?: string;
        };
        let fields = (input["fields"] as Record<string, string> | undefined) ?? {};
        const orgId = auth.organizationId;
        const ctx = await getClientForResource(pluginId, accountId, orgId, parentResourceId);
        if (!ctx) return err("Account or peer resource not found");
        if (!ctx.client.createResource) return err("Plugin does not support creation");

        if (sshKeyId) {
          const typeDef = ctx.plugin.resourceTypes.find((t) => t.id === resourceTypeId);
          const sshKeyFieldKey = typeDef?.agentVm?.sshKeyFieldKey;
          if (!sshKeyFieldKey) {
            return err(`Resource type ${resourceTypeId} does not accept an SSH key at create time`);
          }
          if (fields[sshKeyFieldKey]) {
            return err(`Pass either sshKeyId or fields.${sshKeyFieldKey}, not both`);
          }
          const publicKey = await resolveStoredSshPublicKey(orgId, sshKeyId);
          if (!publicKey) return err("SSH key not found (see list_ssh_keys)");
          fields = { ...fields, [sshKeyFieldKey]: publicKey };
        }

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
              const { ciphertext, iv } = await encrypt(
                state.resolution.value,
                buildAad("secretField", `${created.id}:${state.fieldKey}`, "value"),
              );
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
          } catch (persistErr) {
            console.error("[tools/generic] Failed to persist resource:", persistErr);
          }
        }

        void logAudit({
          organizationId: orgId,
          userId: auth.userId,
          action: "resource.create",
          entityType: "resource",
          entityId: created.id,
          metadata: {
            pluginId,
            resourceTypeId,
            source: auth.source,
            ...(sshKeyId ? { sshKeyId } : {}),
          },
        });

        return ok({ id: created.id, displayName: created.displayName, warnings });
      },
    },

    {
      name: "delete_resource",
      title: "Delete resource",
      description:
        "Permanently delete a resource. Audit-logged. The chat surface confirms with the user before invoking.",
      inputSchema: resourceTargetSchema,
      risk: "destructive",
      handler: async (input, auth) => {
        const { pluginId, accountId, resourceTypeId, resourceId, parentResourceId } = input as {
          pluginId: string;
          accountId: string;
          resourceTypeId: string;
          resourceId: string;
          parentResourceId?: string;
        };
        const ctx = await getClientForResource(
          pluginId,
          accountId,
          auth.organizationId,
          parentResourceId,
        );
        if (!ctx) return err("Account or peer resource not found");
        if (!ctx.client.deleteResource) return err("Plugin does not support deletion");
        try {
          await ctx.client.deleteResource(resourceTypeId, resourceId, accountId);
        } catch (e) {
          return err(e instanceof Error ? e.message : "Deletion failed");
        }
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "resource.delete",
          entityType: "resource",
          entityId: resourceId,
          metadata: { pluginId, resourceTypeId, source: auth.source },
        });
        return ok({ ok: true });
      },
    },

    {
      name: "invoke_action",
      title: "Invoke resource action",
      description:
        "Run a plugin-defined action against a resource (start/stop/restart/etc.). actionId is plugin-specific — discover via the resource's detail schema.",
      inputSchema: {
        ...resourceTargetSchema,
        actionId: z.string(),
      },
      risk: "destructive",
      handler: async (input, auth) => {
        const { pluginId, accountId, resourceTypeId, resourceId, parentResourceId, actionId } =
          input as {
            pluginId: string;
            accountId: string;
            resourceTypeId: string;
            resourceId: string;
            parentResourceId?: string;
            actionId: string;
          };
        const ctx = await getClientForResource(
          pluginId,
          accountId,
          auth.organizationId,
          parentResourceId,
        );
        if (!ctx) return err("Account or peer resource not found");
        if (!ctx.client.invokeAction) return err("Plugin does not support actions");
        try {
          await ctx.client.invokeAction(resourceTypeId, resourceId, actionId, accountId);
        } catch (e) {
          return err(e instanceof Error ? e.message : "Action failed");
        }
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "resource.invoke_action",
          entityType: "resource",
          entityId: resourceId,
          metadata: { pluginId, resourceTypeId, actionId, source: auth.source },
        });
        return ok({ ok: true });
      },
    },

    {
      name: "get_manifest",
      title: "Get resource manifest",
      description:
        "Read the full manifest (YAML/JSON) for a resource. Edits go through apply_manifest.",
      inputSchema: resourceTargetSchema,
      risk: "read",
      handler: async (input, auth) => {
        const { pluginId, accountId, resourceId, parentResourceId } = input as {
          pluginId: string;
          accountId: string;
          resourceId: string;
          parentResourceId?: string;
        };
        const ctx = await getClientForResource(
          pluginId,
          accountId,
          auth.organizationId,
          parentResourceId,
        );
        if (!ctx) return err("Account or peer resource not found");
        if (!ctx.client.getManifest) return err("Plugin does not support manifest viewing");
        const manifest = await ctx.client.getManifest(resourceId, accountId);
        return okText(manifest);
      },
    },

    {
      name: "apply_manifest",
      title: "Apply resource manifest",
      description:
        "Apply an updated manifest (YAML/JSON) to a resource — primary edit path for k8s, postgres, and similar plugins. Audit-logged.",
      inputSchema: {
        ...resourceTargetSchema,
        manifest: z.string(),
      },
      risk: "destructive",
      handler: async (input, auth) => {
        const { pluginId, accountId, resourceTypeId, resourceId, parentResourceId, manifest } =
          input as {
            pluginId: string;
            accountId: string;
            resourceTypeId: string;
            resourceId: string;
            parentResourceId?: string;
            manifest: string;
          };
        const ctx = await getClientForResource(
          pluginId,
          accountId,
          auth.organizationId,
          parentResourceId,
        );
        if (!ctx) return err("Account or peer resource not found");
        if (!ctx.client.applyManifest) return err("Plugin does not support manifest editing");
        try {
          await ctx.client.applyManifest(resourceId, accountId, manifest);
        } catch (e) {
          return err(e instanceof Error ? e.message : "applyManifest failed");
        }
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "resource.apply_manifest",
          entityType: "resource",
          entityId: resourceId,
          metadata: { pluginId, resourceTypeId, source: auth.source },
        });
        return ok({ ok: true });
      },
    },

    {
      name: "attach_resource",
      title: "Attach resource",
      description:
        "Attach a source resource to a target resource (e.g. disk → VM). Both must be in the same account. Plugin-specific semantics; see resource type's attachTargets.",
      inputSchema: {
        sourceTypeId: z.string(),
        sourceResourceId: z.string(),
        targetTypeId: z.string(),
        targetResourceId: z.string(),
        accountId: z.string(),
        pluginId: z.string(),
      },
      risk: "destructive",
      handler: async (input, auth) => {
        const {
          pluginId,
          accountId,
          sourceTypeId,
          sourceResourceId,
          targetTypeId,
          targetResourceId,
        } = input as {
          pluginId: string;
          accountId: string;
          sourceTypeId: string;
          sourceResourceId: string;
          targetTypeId: string;
          targetResourceId: string;
        };
        const ctx = await getClientForAccount(accountId, auth.organizationId);
        if (!ctx) return err("Account not found");
        if (ctx.account.pluginId !== pluginId) return err("Account/plugin mismatch");
        if (!ctx.client.attachResource) return err("Plugin does not support attach");
        try {
          await ctx.client.attachResource(
            sourceTypeId,
            sourceResourceId,
            targetTypeId,
            targetResourceId,
            accountId,
          );
        } catch (e) {
          return err(e instanceof Error ? e.message : "attach failed");
        }
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "resource.attach",
          entityType: "resource",
          entityId: targetResourceId,
          metadata: {
            pluginId,
            sourceTypeId,
            sourceResourceId,
            targetTypeId,
            source: auth.source,
          },
        });
        return ok({ ok: true });
      },
    },
  ];
}
