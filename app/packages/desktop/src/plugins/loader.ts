/**
 * Desktop plugin loader. Loads all bundled plugin packages lazily; env can
 * disable whole plugins (DISABLED_PLUGINS) or restrict a plugin to specific
 * resource types (ENABLED_RESOURCE_TYPES).
 */
import type { Plugin } from "@infrawrench/plugin-base";
import { pluginManifestSchema, validatePreflightContract } from "@infrawrench/plugin-base";

import { DISABLED_PLUGINS, ENABLED_RESOURCE_TYPES } from "../../env";
import { PLUGIN_MODULES } from "./modules";

interface LoadedPlugin {
  plugin: Plugin;
}

let _loaded: LoadedPlugin[] | null = null;

export async function loadPlugins(): Promise<LoadedPlugin[]> {
  if (_loaded) return _loaded;

  const loaded: LoadedPlugin[] = [];

  const disabledPlugins = new Set(DISABLED_PLUGINS);

  for (const moduleLoader of PLUGIN_MODULES) {
    let mod: { plugin: Plugin };
    try {
      mod = await moduleLoader();
    } catch (err) {
      console.error(`[plugin-loader] Failed to import a plugin module:`, err);
      continue;
    }

    const result = pluginManifestSchema.safeParse(mod.plugin.manifest);
    if (!result.success) {
      console.error(
        `[plugin-loader] Invalid manifest for "${mod.plugin.manifest?.id ?? "unknown"}"`,
      );
      continue;
    }

    const contractProblem = validatePreflightContract(mod.plugin);
    if (contractProblem) {
      console.error(
        `[plugin-loader] Invalid preflight contract for "${mod.plugin.manifest.id}": ${contractProblem}`,
      );
      continue;
    }

    const pluginId = mod.plugin.manifest.id;
    if (disabledPlugins.has(pluginId)) continue;

    const allowlist = ENABLED_RESOURCE_TYPES[pluginId];
    const allowedTypeIds = allowlist ? new Set(allowlist) : null;
    const filteredPlugin: Plugin = allowedTypeIds
      ? {
          ...mod.plugin,
          resourceTypes: mod.plugin.resourceTypes.filter((rt) => allowedTypeIds.has(rt.id)),
        }
      : mod.plugin;

    loaded.push({ plugin: filteredPlugin });
  }

  _loaded = loaded;
  return loaded;
}

export async function getPlugin(pluginId: string): Promise<LoadedPlugin | undefined> {
  const plugins = await loadPlugins();
  return plugins.find((p) => p.plugin.manifest.id === pluginId);
}
