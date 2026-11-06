/**
 * Desktop plugin loader. Loads all bundled plugin packages lazily; env can
 * disable whole plugins (DISABLED_PLUGINS) or restrict a plugin to specific
 * resource types (ENABLED_RESOURCE_TYPES).
 */
import type { HostPlugin, Plugin } from "@infrawrench/plugin-base";
import { validatePluginContract } from "@infrawrench/plugin-base";
import { hostPlugins } from "@infrawrench/plugin-base/effect";
import { pluginManifestSchema, validate } from "@infrawrench/plugin-base/validation";

import { DISABLED_PLUGINS, ENABLED_RESOURCE_TYPES } from "../../env";
import { PLUGIN_MODULES } from "./modules";

interface LoadedPlugin {
  /** Contract methods run on call and return Promises; see `hostPlugin`. */
  plugin: HostPlugin;
}

let _loaded: LoadedPlugin[] | null = null;

export async function loadPlugins(): Promise<LoadedPlugin[]> {
  if (_loaded) return _loaded;

  const valid: Plugin[] = [];

  const disabledPlugins = new Set(DISABLED_PLUGINS);

  for (const moduleLoader of PLUGIN_MODULES) {
    let mod: { plugin: Plugin };
    try {
      mod = await moduleLoader();
    } catch (err) {
      console.error(`[plugin-loader] Failed to import a plugin module:`, err);
      continue;
    }

    const result = validate(pluginManifestSchema, mod.plugin.manifest);
    if (!result.success) {
      console.error(
        `[plugin-loader] Invalid manifest for "${mod.plugin.manifest?.id ?? "unknown"}"`,
      );
      continue;
    }

    const problems = validatePluginContract(mod.plugin);
    if (problems.length > 0) {
      console.error(`[plugin-loader] "${mod.plugin.manifest.id}" breaks the contract:`, problems);
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

    valid.push(filteredPlugin);
  }

  _loaded = hostPlugins(valid).map((plugin) => ({ plugin }));
  return _loaded;
}

export async function getPlugin(pluginId: string): Promise<LoadedPlugin | undefined> {
  const plugins = await loadPlugins();
  return plugins.find((p) => p.plugin.manifest.id === pluginId);
}
