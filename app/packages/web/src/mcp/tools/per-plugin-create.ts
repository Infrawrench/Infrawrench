import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodTypeAny } from "zod";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db/client";
import { resources, secretFieldStates } from "../../db/schema";
import { encrypt, buildAad } from "../../services/encryption";
import { logAudit } from "../../services/audit";
import { loadPlugins } from "../../plugins/loader";
import { getClientForResource } from "../../services/plugin-clients";
import { normalizeResourceCreateResult } from "@infrawrench/plugin-base";
import type { FieldDefinition, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import type { McpAuthContext } from "../auth";

function safeName(input: string): string {
  return input.replace(/[^a-zA-Z0-9_]/g, "_");
}

function inputSchemaForType(type: ResourceTypeDefinition): Record<string, ZodTypeAny> {
  const shape: Record<string, ZodTypeAny> = {
    accountId: z.string().describe("Connected account id (see list_accounts)"),
    parentResourceId: z.string().optional(),
  };
  for (const f of type.fields) {
    let leaf: ZodTypeAny = scalarFor(f);
    if (f.description) leaf = leaf.describe(f.description);
    if (!f.required) leaf = leaf.optional();
    shape[f.key] = leaf;
  }
  return shape;
}

function scalarFor(f: FieldDefinition): ZodTypeAny {
  switch (f.kind) {
    case "number":
      return z.union([z.number(), z.string()]);
    case "boolean":
      return z.union([z.boolean(), z.string()]);
    case "enum":
      if (f.enumValues && f.enumValues.length > 0) {
        return z.enum(f.enumValues as [string, ...string[]]);
      }
      return z.string();
    case "secret":
    case "association":
    case "string":
    default:
      return z.string();
  }
}

export async function registerPerPluginCreateTools(
  server: McpServer,
  auth: McpAuthContext,
): Promise<void> {
  const orgId = auth.organizationId;
  const plugins = await loadPlugins();

  for (const loaded of plugins) {
    const pluginId = loaded.plugin.manifest.id;
    for (const type of loaded.plugin.resourceTypes) {
      if (!type.supportsCreate) continue;
      const toolName = `${safeName(pluginId)}_create_${safeName(type.id)}`;

      server.registerTool(
        toolName,
        {
          title: `Create ${type.displayName} (${loaded.plugin.manifest.displayName})`,
          description:
            `Create a new ${type.displayName} via the ${loaded.plugin.manifest.displayName} plugin. ` +
            `Pass the connected accountId plus the type's fields. ` +
            (type.description ?? ""),
          inputSchema: inputSchemaForType(type),
        },
        async (input) => {
          const { accountId, parentResourceId, ...rest } = input as Record<string, unknown> & {
            accountId: string;
            parentResourceId?: string;
          };

          const fields: Record<string, string> = {};
          for (const [k, v] of Object.entries(rest)) {
            if (v == null) continue;
            fields[k] = typeof v === "string" ? v : String(v);
          }

          const ctx = await getClientForResource(pluginId, accountId, orgId, parentResourceId);
          if (!ctx) {
            return {
              content: [{ type: "text", text: "Account or peer resource not found" }],
              isError: true,
            };
          }
          if (!ctx.client.createResource) {
            return {
              content: [{ type: "text", text: "Plugin does not support creation" }],
              isError: true,
            };
          }

          let createReturn;
          try {
            createReturn = await ctx.client.createResource(
              type.id,
              accountId,
              fields,
              parentResourceId,
            );
          } catch (e) {
            return {
              content: [
                {
                  type: "text",
                  text: e instanceof Error ? e.message : "Resource creation failed",
                },
              ],
              isError: true,
            };
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
                  resourceTypeId: type.id,
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
            } catch (err) {
              // Non-critical; the next sync will reconcile.
              console.error("[mcp/per-plugin-create] Failed to persist resource:", err);
            }
          }

          void logAudit({
            organizationId: orgId,
            userId: auth.userId,
            action: "resource.create",
            entityType: "resource",
            entityId: created.id,
            metadata: { pluginId, resourceTypeId: type.id, source: "mcp", tool: toolName },
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { id: created.id, displayName: created.displayName, warnings },
                  null,
                  2,
                ),
              },
            ],
          };
        },
      );
    }
  }
}
