/**
 * Desktop plugin loader.
 * Imports the same blessed-plugins.json from the web package.
 * Same security boundary — same file, same workspace.
 */
import type { Plugin, PluginRegistry } from "@infrawrench/plugin-base";
import { pluginManifestSchema } from "@infrawrench/plugin-base";

// Import registry from the web package (the authoritative source)
import registry from "@blessed-plugins";

const blessedRegistry = registry as PluginRegistry;

const PLUGIN_MODULES: Record<string, () => Promise<{ plugin: Plugin }>> = {
  "@infrawrench/plugin-digitalocean": () => import("@infrawrench/plugin-digitalocean"),
  "@infrawrench/plugin-docker": () => import("@infrawrench/plugin-docker"),
  "@infrawrench/plugin-gcp": () => import("@infrawrench/plugin-gcp"),
  "@infrawrench/plugin-kubernetes": () => import("@infrawrench/plugin-kubernetes"),
  "@infrawrench/plugin-memcached": () => import("@infrawrench/plugin-memcached"),
  "@infrawrench/plugin-mysql": () => import("@infrawrench/plugin-mysql"),
  "@infrawrench/plugin-postgres": () => import("@infrawrench/plugin-postgres"),
  "@infrawrench/plugin-redis": () => import("@infrawrench/plugin-redis"),
  "@infrawrench/plugin-ssh": () => import("@infrawrench/plugin-ssh"),
};

export interface LoadedPlugin {
  plugin: Plugin;
}

let _loaded: LoadedPlugin[] | null = null;

export async function loadPlugins(): Promise<LoadedPlugin[]> {
  if (_loaded) return _loaded;

  const loaded: LoadedPlugin[] = [];

  for (const entry of blessedRegistry.entries) {
    const moduleLoader = PLUGIN_MODULES[entry.packageName];
    if (!moduleLoader) continue;

    let mod: { plugin: Plugin };
    try {
      mod = await moduleLoader();
    } catch (err) {
      console.error(`[plugin-loader] Failed to import "${entry.packageName}":`, err);
      continue;
    }

    const result = pluginManifestSchema.safeParse(mod.plugin.manifest);
    if (!result.success) {
      console.error(`[plugin-loader] Invalid manifest for "${entry.packageName}"`);
      continue;
    }

    if (mod.plugin.manifest.id !== entry.id) {
      console.error(`[plugin-loader] Plugin id mismatch for "${entry.packageName}"`);
      continue;
    }

    loaded.push({ plugin: mod.plugin });
  }

  _loaded = loaded;
  return loaded;
}

export async function getPlugin(pluginId: string): Promise<LoadedPlugin | undefined> {
  const plugins = await loadPlugins();
  return plugins.find((p) => p.plugin.manifest.id === pluginId);
}
