import { loadPlugins } from "../../plugins/loader";

/**
 * The `PluginId` and `ResourceTypeId` components, enums of exactly the plugins
 * and resource types loaded, built at spec time so the document always lists
 * what the running server accepts. Endpoint definitions cannot load plugins,
 * so domains refer to these by `$ref` (`@infrawrench/api-contract`,
 * `http/schemas/plugin-registry.ts`).
 */
export async function buildDynamicEnums(): Promise<Record<string, Record<string, unknown>>> {
  const loaded = await loadPlugins();

  const pluginIds = loaded.map((p) => p.plugin.manifest.id).sort();
  const resourceTypeIds = Array.from(
    new Set(loaded.flatMap((p) => p.plugin.resourceTypes.map((rt) => rt.id))),
  ).sort();

  if (pluginIds.length === 0) throw new Error("No plugins loaded, cannot build OpenAPI enums");
  if (resourceTypeIds.length === 0)
    throw new Error("No resource types loaded, cannot build OpenAPI enums");

  return {
    PluginId: {
      type: "string",
      enum: pluginIds,
      description: "Manifest id of an installed plugin.",
      example: pluginIds[0],
    },
    ResourceTypeId: {
      type: "string",
      enum: resourceTypeIds,
      description:
        "Resource type id. Note: not every plugin exposes every type; see the plugin's `resourceTypes` for the valid (pluginId, typeId) pairs.",
      example: resourceTypeIds[0],
    },
  };
}
