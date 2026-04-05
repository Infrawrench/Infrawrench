import type { Plugin, PluginRegistry } from "@infrawrench/plugin-base";
import { pluginManifestSchema } from "@infrawrench/plugin-base";
import registry from "./blessed-plugins.json";

const blessedRegistry = registry as PluginRegistry;

/** Statically imported plugins — only blessed plugins are ever imported */
const PLUGIN_MODULES: Record<string, () => Promise<{ plugin: Plugin }>> = {
  "@infrawrench/plugin-digitalocean": () => import("@infrawrench/plugin-digitalocean"),
  "@infrawrench/plugin-kubernetes": () => import("@infrawrench/plugin-kubernetes"),
  "@infrawrench/plugin-postgres": () => import("@infrawrench/plugin-postgres"),
};

export interface LoadedPlugin {
  plugin: Plugin;
  registryEntry: (typeof blessedRegistry.entries)[number];
}

let _loaded: LoadedPlugin[] | null = null;

/**
 * Load and validate all blessed plugins.
 * Results are cached after the first call.
 * In Next.js, this is called in server components/actions — never on the client.
 */
export async function loadPlugins(): Promise<LoadedPlugin[]> {
  if (_loaded) return _loaded;

  const loaded: LoadedPlugin[] = [];

  for (const entry of blessedRegistry.entries) {
    const moduleLoader = PLUGIN_MODULES[entry.packageName];
    if (!moduleLoader) {
      console.warn(
        `[plugin-loader] No module registered for "${entry.packageName}" — skipping`,
      );
      continue;
    }

    let mod: { plugin: Plugin };
    try {
      mod = await moduleLoader();
    } catch (err) {
      console.error(`[plugin-loader] Failed to import "${entry.packageName}":`, err);
      continue;
    }

    const { plugin } = mod;

    // Validate manifest with Zod
    const result = pluginManifestSchema.safeParse(plugin.manifest);
    if (!result.success) {
      console.error(
        `[plugin-loader] Invalid manifest for "${entry.packageName}":`,
        result.error.flatten(),
      );
      continue;
    }

    // Verify plugin ID matches the registry
    if (plugin.manifest.id !== entry.id) {
      console.error(
        `[plugin-loader] Plugin manifest id "${plugin.manifest.id}" does not match registry id "${entry.id}" — refusing to load`,
      );
      continue;
    }

    loaded.push({ plugin, registryEntry: entry });
  }

  _loaded = loaded;
  return loaded;
}

/** Get a single loaded plugin by its manifest id */
export async function getPlugin(pluginId: string): Promise<LoadedPlugin | undefined> {
  const plugins = await loadPlugins();
  return plugins.find((p) => p.plugin.manifest.id === pluginId);
}
