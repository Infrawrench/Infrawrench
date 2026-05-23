/**
 * Desktop plugin loader.
 * Imports the same blessed-plugins.json from the web package.
 * Same security boundary — same file, same workspace.
 */
import type { Plugin, PluginRegistry } from "@infrawrench/plugin-base";
import { pluginManifestSchema } from "@infrawrench/plugin-base";

import registry from "@blessed-plugins";
import { DISABLED_PLUGINS, ENABLED_RESOURCE_TYPES } from "../../env";

const blessedRegistry = registry as PluginRegistry;

const PLUGIN_MODULES: Record<string, () => Promise<{ plugin: Plugin }>> = {
  "@infrawrench/plugin-aws": () => import("@infrawrench/plugin-aws"),
  "@infrawrench/plugin-digitalocean": () => import("@infrawrench/plugin-digitalocean"),
  "@infrawrench/plugin-docker": () => import("@infrawrench/plugin-docker"),
  "@infrawrench/plugin-gcp": () => import("@infrawrench/plugin-gcp"),
  "@infrawrench/plugin-hetzner": () => import("@infrawrench/plugin-hetzner"),
  "@infrawrench/plugin-kafka": () => import("@infrawrench/plugin-kafka"),
  "@infrawrench/plugin-kubernetes": () => import("@infrawrench/plugin-kubernetes"),
  "@infrawrench/plugin-memcached": () => import("@infrawrench/plugin-memcached"),
  "@infrawrench/plugin-mongodb": () => import("@infrawrench/plugin-mongodb"),
  "@infrawrench/plugin-mysql": () => import("@infrawrench/plugin-mysql"),
  "@infrawrench/plugin-mssql": () => import("@infrawrench/plugin-mssql"),
  "@infrawrench/plugin-neon": () => import("@infrawrench/plugin-neon"),
  "@infrawrench/plugin-postgres": () => import("@infrawrench/plugin-postgres"),
  "@infrawrench/plugin-redis": () => import("@infrawrench/plugin-redis"),
  "@infrawrench/plugin-scaleway": () => import("@infrawrench/plugin-scaleway"),
  "@infrawrench/plugin-ssh": () => import("@infrawrench/plugin-ssh"),
  "@infrawrench/plugin-cloudflare": () => import("@infrawrench/plugin-cloudflare"),
  "@infrawrench/plugin-ovh": () => import("@infrawrench/plugin-ovh"),
  "@infrawrench/plugin-databricks": () => import("@infrawrench/plugin-databricks"),
  "@infrawrench/plugin-turso": () => import("@infrawrench/plugin-turso"),
  "@infrawrench/plugin-planetscale": () => import("@infrawrench/plugin-planetscale"),
  "@infrawrench/plugin-azure": () => import("@infrawrench/plugin-azure"),
  "@infrawrench/plugin-fly": () => import("@infrawrench/plugin-fly"),
  "@infrawrench/plugin-vercel": () => import("@infrawrench/plugin-vercel"),
  "@infrawrench/plugin-netlify": () => import("@infrawrench/plugin-netlify"),
  "@infrawrench/plugin-cloudinary": () => import("@infrawrench/plugin-cloudinary"),
  "@infrawrench/plugin-clickhouse": () => import("@infrawrench/plugin-clickhouse"),
  "@infrawrench/plugin-opensearch": () => import("@infrawrench/plugin-opensearch"),
};

interface LoadedPlugin {
  plugin: Plugin;
}

let _loaded: LoadedPlugin[] | null = null;

export async function loadPlugins(): Promise<LoadedPlugin[]> {
  if (_loaded) return _loaded;

  const loaded: LoadedPlugin[] = [];

  const disabledPlugins = new Set(DISABLED_PLUGINS);

  for (const entry of blessedRegistry.entries) {
    if (disabledPlugins.has(entry.id)) continue;
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

    const allowlist = ENABLED_RESOURCE_TYPES[entry.id];
    const filteredPlugin: Plugin = allowlist
      ? {
          ...mod.plugin,
          resourceTypes: mod.plugin.resourceTypes.filter((rt) => allowlist.includes(rt.id)),
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
