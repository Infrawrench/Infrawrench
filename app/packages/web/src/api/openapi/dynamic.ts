import { loadPlugins } from "../../plugins/loader";
import { z } from "./zod";

/**
 * Build Zod enum schemas whose values are sourced from the live plugin registry.
 * Called at spec-build time so the spec always reflects exactly what's loaded.
 */
export interface DynamicEnums {
  PluginId: z.ZodEnum<[string, ...string[]]>;
  ResourceTypeId: z.ZodEnum<[string, ...string[]]>;
  CredentialFormatId: z.ZodEnum<[string, ...string[]]> | z.ZodString;
  pluginIds: string[];
  resourceTypeIds: string[];
  pluginsMeta: Array<{
    id: string;
    displayName: string;
    resourceTypes: Array<{ id: string; displayName: string; pluralDisplayName?: string }>;
  }>;
}

export async function buildDynamicEnums(): Promise<DynamicEnums> {
  const loaded = await loadPlugins();

  const pluginIds = loaded.map((p) => p.plugin.manifest.id).sort();
  const resourceTypeIds = Array.from(
    new Set(loaded.flatMap((p) => p.plugin.resourceTypes.map((rt) => rt.id))),
  ).sort();
  const credentialFormatIds = Array.from(
    new Set(
      loaded.flatMap((p) =>
        p.plugin.resourceTypes.flatMap((rt) => (rt.credentialFormats ?? []).map((f) => f.id)),
      ),
    ),
  ).sort();

  const pluginsMeta = loaded.map((p) => ({
    id: p.plugin.manifest.id,
    displayName: p.plugin.manifest.displayName,
    resourceTypes: p.plugin.resourceTypes.map((rt) => ({
      id: rt.id,
      displayName: rt.displayName,
      pluralDisplayName: rt.pluralDisplayName,
    })),
  }));

  if (pluginIds.length === 0) throw new Error("No plugins loaded — cannot build OpenAPI enums");
  if (resourceTypeIds.length === 0)
    throw new Error("No resource types loaded — cannot build OpenAPI enums");

  const PluginId = z.enum(pluginIds as [string, ...string[]]).openapi("PluginId", {
    description: "Manifest id of an installed plugin.",
    example: pluginIds[0]!,
  });

  const ResourceTypeId = z
    .enum(resourceTypeIds as [string, ...string[]])
    .openapi("ResourceTypeId", {
      description:
        "Resource type id. Note: not every plugin exposes every type — see the plugin's `resourceTypes` for the valid (pluginId, typeId) pairs.",
      example: resourceTypeIds[0]!,
    });

  const CredentialFormatId =
    credentialFormatIds.length > 0
      ? z.enum(credentialFormatIds as [string, ...string[]]).openapi("CredentialFormatId", {
          description: "Identifier of a credential export format declared by a resource type.",
        })
      : z.string().openapi("CredentialFormatId");

  return {
    PluginId,
    ResourceTypeId,
    CredentialFormatId,
    pluginIds,
    resourceTypeIds,
    pluginsMeta,
  };
}
