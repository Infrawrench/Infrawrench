import { Schema } from "effect";
import { holdSecretWrites, setLiteralSecretState } from "@infrawrench/server-core/secret-states";
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

function scalarFor(f: FieldDefinition): Schema.Top {
  switch (f.kind) {
    case "number":
      return Schema.Union([Schema.Finite, Schema.String]);
    case "boolean":
      return Schema.Union([Schema.Boolean, Schema.String]);
    case "enum":
      if (f.enumValues && f.enumValues.length > 0) {
        return Schema.Literals(f.enumValues);
      }
      return Schema.String;
    case "secret":
    case "association":
    case "string":
    default:
      return Schema.String;
  }
}

function inputSchemaForType(type: ResourceTypeDefinition): Record<string, Schema.Top> {
  const shape: Record<string, Schema.Top> = {
    accountId: Schema.String.annotate({ description: "Connected account id (see list_accounts)" }),
    parentResourceId: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "For sidecar plugins (e.g. creating a kubernetes resource inside a managed cluster): " +
          "the parent resource id providing credentials; see list_resource_sidecars",
      }),
    ),
  };
  for (const f of type.fields) {
    const scalar = scalarFor(f);
    const leaf = f.description ? scalar.annotate({ description: f.description }) : scalar;
    shape[f.key] = f.required ? leaf : Schema.optionalKey(leaf);
  }
  // VM-style types that install an SSH key at create time (agentVm declares
  // which field carries it) additionally accept a stored org key by id.
  const sshKeyFieldKey = type.agentVm?.sshKeyFieldKey;
  if (sshKeyFieldKey) {
    shape["sshKeyId"] = Schema.optionalKey(
      Schema.String.annotate({
        description:
          "Stored org SSH key id (see list_ssh_keys); its public key is installed on the " +
          `machine for SSH access. Alternative to ${sshKeyFieldKey}.`,
      }),
    );
    if (!shape[sshKeyFieldKey]) {
      shape[sshKeyFieldKey] = Schema.optionalKey(
        Schema.String.annotate({
          description:
            "OpenSSH public key text to install for SSH access (alternative to sshKeyId)",
        }),
      );
    }
  }
  return shape;
}

/**
 * The type's description, then the provider's API reference for the create
 * call when the type declares one (`ResourceTypeDefinition.apiDocsUrl`).
 */
function withApiDocs(description: string, provider: string, apiDocsUrl: string | undefined) {
  if (!apiDocsUrl) return description;
  const text = description.trim();
  const sentence = text === "" || /[.!?]$/.test(text) ? text : `${text}.`;
  return `${sentence} ${provider} API reference: ${apiDocsUrl}`.trim();
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
          withApiDocs(type.description ?? "", loaded.plugin.manifest.displayName, type.apiDocsUrl),
        inputSchema: inputSchemaForType(type),
        risk: "write",
        permission: "resources:write",
        pluginId,
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

          const heldSecrets = holdSecretWrites();
          let createReturn;
          try {
            const create = ctx.client.createResource.bind(ctx.client);
            createReturn = await heldSecrets.run(() =>
              create(typeId, accountId, fields, parentResourceId),
            );
          } catch (e) {
            return err(e instanceof Error ? e.message : "Resource creation failed");
          }

          const { resource: created, warnings } = normalizeResourceCreateResult(createReturn);

          try {
            if (ctx.account.pluginId === pluginId) {
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
            }
            await heldSecrets.flush();
          } catch (persistErr) {
            console.error("[tools/per-plugin-create] Failed to persist resource:", persistErr);
            warnings.push({
              code: "secret-persist-failed",
              message: `${created.displayName} was created, but Infrawrench could not store it and any credentials it returned.`,
            });
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
