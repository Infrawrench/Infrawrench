/**
 * Plugin loader for the Electron main process.
 *
 * The renderer has its own (`src/plugins/loader.ts`) but that module is part of
 * the bundler-resolved ESM tree: importing it from here drags a static
 * `@infrawrench/plugin-base` value import into the CommonJS main tree, which
 * `node16` resolution rejects outright. The plugin list is the same; only the
 * module semantics differ.
 *
 * Every entry is a dynamic import, so a CLI invocation that never touches a
 * plugin (login, orgs, costs) pays nothing for this file existing.
 */
import type { Plugin } from "@infrawrench/plugin-base" with { "resolution-mode": "import" };

import { DISABLED_PLUGINS } from "../../env";

const PLUGIN_MODULES: Array<() => Promise<{ plugin: Plugin }>> = [
  () => import("@infrawrench/plugin-aws"),
  () => import("@infrawrench/plugin-digitalocean"),
  () => import("@infrawrench/plugin-docker"),
  () => import("@infrawrench/plugin-gcp"),
  () => import("@infrawrench/plugin-hetzner"),
  () => import("@infrawrench/plugin-kafka"),
  () => import("@infrawrench/plugin-kubernetes"),
  () => import("@infrawrench/plugin-memcached"),
  () => import("@infrawrench/plugin-mongodb"),
  () => import("@infrawrench/plugin-mysql"),
  () => import("@infrawrench/plugin-mssql"),
  () => import("@infrawrench/plugin-neon"),
  () => import("@infrawrench/plugin-postgres"),
  () => import("@infrawrench/plugin-redis"),
  () => import("@infrawrench/plugin-scaleway"),
  () => import("@infrawrench/plugin-ssh"),
  () => import("@infrawrench/plugin-cloudflare"),
  () => import("@infrawrench/plugin-ovh"),
  () => import("@infrawrench/plugin-databricks"),
  () => import("@infrawrench/plugin-turso"),
  () => import("@infrawrench/plugin-planetscale"),
  () => import("@infrawrench/plugin-azure"),
  () => import("@infrawrench/plugin-fly"),
  () => import("@infrawrench/plugin-vercel"),
  () => import("@infrawrench/plugin-netlify"),
  () => import("@infrawrench/plugin-cloudinary"),
  () => import("@infrawrench/plugin-clickhouse"),
  () => import("@infrawrench/plugin-opensearch"),
];

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
