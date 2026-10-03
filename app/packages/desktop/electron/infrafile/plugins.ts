/**
 * Plugin loader for the Electron main process (deploy's plugin host and the
 * CLI peer client).
 *
 * Deliberately lighter than the renderer's `src/plugins/loader.ts`: it skips
 * manifest validation and the ENABLED_RESOURCE_TYPES filter, and only honours
 * DISABLED_PLUGINS. The plugin list itself is shared (`src/plugins/modules.ts`)
 * so the two cannot drift apart.
 */
import type { Plugin } from "@infrawrench/plugin-base" with { "resolution-mode": "import" };

import { DISABLED_PLUGINS } from "../../env";
import { PLUGIN_MODULES } from "../../src/plugins/modules";

export interface LoadedPlugin {
  plugin: Plugin;
}

let cached: LoadedPlugin[] | null = null;

/** Every enabled plugin, loaded once per process. */
export async function loadPlugins(): Promise<LoadedPlugin[]> {
  if (cached) return cached;

  const disabled = new Set<string>(DISABLED_PLUGINS);
  const loaded: LoadedPlugin[] = [];

  for (const load of PLUGIN_MODULES) {
    try {
      const mod = await load();
      // A plugin that fails to import must not take the whole deploy with it —
      // the one the user actually needs may well have loaded fine.
      if (!disabled.has(mod.plugin.manifest.id)) loaded.push({ plugin: mod.plugin });
    } catch (err) {
      console.error("[cli] failed to load a plugin module:", err);
    }
  }

  cached = loaded;
  return loaded;
}

/** One plugin by id, or null when it is absent or disabled. */
export async function getPlugin(pluginId: string): Promise<LoadedPlugin | null> {
  const all = await loadPlugins();
  return all.find((p) => p.plugin.manifest.id === pluginId) ?? null;
}
