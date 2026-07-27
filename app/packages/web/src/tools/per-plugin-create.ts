import { z, type ZodTypeAny } from "zod";
import { setLiteralSecretState } from "@infrawrench/server-core/secret-states";
import { upsertCreatedResource } from "@infrawrench/server-core/created-resource";
import { logAudit } from "../services/audit";
import { loadPlugins } from "../plugins/loader";
import { getClientForResource } from "../services/plugin-clients";
import { normalizeResourceCreateResult } from "@infrawrench/plugin-base";
import type { FieldDefinition, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { resolveStoredSshPublicKey } from "./ssh-key-lookup";
import { ok, err, type ToolDefinition } from "./types";

function safeName(input: string): string {
  return input.replace(/[^a-zA-Z0-9_]/g, "_");
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

function inputSchemaForType(type: ResourceTypeDefinition): Record<string, ZodTypeAny> {
  const shape: Record<string, ZodTypeAny> = {
    accountId: z.string().describe("Connected account id (see list_accounts)"),
    parentResourceId: z
      .string()
      .optional()
      .describe(
        "For sidecar plugins (e.g. creating a kubernetes resource inside a managed cluster): " +
          "the parent resource id providing credentials — see list_resource_sidecars",
      ),
  };
  for (const f of type.fields) {
    let leaf: ZodTypeAny = scalarFor(f);
    if (f.description) leaf = leaf.describe(f.description);
    if (!f.required) leaf = leaf.optional();
    shape[f.key] = leaf;
  }
  // VM-style types that install an SSH key at create time (agentVm declares
  // which field carries it) additionally accept a stored org key by id.
  const sshKeyFieldKey = type.agentVm?.sshKeyFieldKey;
  if (sshKeyFieldKey) {
    shape["sshKeyId"] = z
      .string()
      .optional()
      .describe(
        "Stored org SSH key id (see list_ssh_keys) — its public key is installed on the " +
          `machine for SSH access. Alternative to ${sshKeyFieldKey}.`,
      );
    if (!shape[sshKeyFieldKey]) {
      shape[sshKeyFieldKey] = z
        .string()
        .optional()
        .describe("OpenSSH public key text to install for SSH access (alternative to sshKeyId)");
    }
  }
  return shape;
}

export async function perPluginCreateTools(): Promise<ToolDefinition[]> {
  const plugins = await loadPlugins();
  const out: ToolDefinition[] = [];

  for (const loaded of plugins) {
    const pluginId = loaded.plugin.manifest.id;
    for (const type of loaded.plugin.resourceTypes) {
      if (!type.supportsCreate) continue;
      const toolName = `${safeName(pluginId)}_create_${safeName(type.id)}`;
      const typeId = type.id;
      const sshKeyFieldKey = type.agentVm?.sshKeyFieldKey;

      out.push({
        name: toolName,
        title: `Create ${type.displayName} (${loaded.plugin.manifest.displayName})`,
        description:
          `Create a new ${type.displayName} via the ${loaded.plugin.manifest.displayName} plugin. ` +
          `Pass the connected accountId plus the type's fields. ` +
          (type.description ?? ""),
        inputSchema: inputSchemaForType(type),
        risk: "write",
        permission: "resources:write",
        handler: async (input, auth) => {
          const { accountId, parentResourceId, ...rest } = input as Record<string, unknown> & {
            accountId: string;
            parentResourceId?: string;
          };
          const orgId = auth.organizationId;

          // Resolve a stored org SSH key to its public key for VM types.
          let usedSshKeyId: string | undefined;
          if (sshKeyFieldKey) {
            const sshKeyId = rest["sshKeyId"];
            delete rest["sshKeyId"];
            if (typeof sshKeyId === "string" && sshKeyId !== "") {
              if (rest[sshKeyFieldKey]) {
                return err(`Pass either sshKeyId or ${sshKeyFieldKey}, not both`);
              }
              const publicKey = await resolveStoredSshPublicKey(orgId, sshKeyId);
              if (!publicKey) return err("SSH key not found (see list_ssh_keys)");
              rest[sshKeyFieldKey] = publicKey;
              usedSshKeyId = sshKeyId;
            }
          }

          const fields: Record<string, string> = {};
          for (const [k, v] of Object.entries(rest)) {
            if (v == null) continue;
            fields[k] = typeof v === "string" ? v : String(v);
          }
          const ctx = await getClientForResource(pluginId, accountId, orgId, parentResourceId);
          if (!ctx) return err("Account or peer resource not found");
          if (!ctx.client.createResource) return err("Plugin does not support creation");

          let createReturn;
          try {
            createReturn = await ctx.client.createResource(
              typeId,
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
              await upsertCreatedResource({
                organizationId: orgId,
                pluginId,
                resourceTypeId: typeId,
                accountId,
                resource: created,
              });
              for (const state of created.secretStates ?? []) {
                if (state.resolution.kind !== "plaintext") continue;
                await setLiteralSecretState(created.id, state.fieldKey, state.resolution.value);
              }
            } catch (persistErr) {
              console.error("[tools/per-plugin-create] Failed to persist resource:", persistErr);
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
              resourceTypeId: typeId,
              source: auth.source,
              tool: toolName,
              ...(usedSshKeyId ? { sshKeyId: usedSshKeyId } : {}),
            },
          });

          return ok({ id: created.id, displayName: created.displayName, warnings });
        },
      });
    }
  }

  return out;
}
