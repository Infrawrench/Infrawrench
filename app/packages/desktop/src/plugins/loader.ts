/**
 * Desktop plugin loader. Loads all bundled plugin packages lazily; env can
 * disable whole plugins (DISABLED_PLUGINS) or restrict a plugin to specific
 * resource types (ENABLED_RESOURCE_TYPES).
 */
import type { Plugin } from "@infrawrench/plugin-base";
import { pluginManifestSchema } from "@infrawrench/plugin-base";

import { DISABLED_PLUGINS, ENABLED_RESOURCE_TYPES } from "../../env";

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
  () => import("@infrawrench/plugin-anthropic"),
  () => import("@infrawrench/plugin-assemblyai"),
  () => import("@infrawrench/plugin-cartesia"),
  () => import("@infrawrench/plugin-cohere"),
  () => import("@infrawrench/plugin-deepgram"),
  () => import("@infrawrench/plugin-deepseek"),
  () => import("@infrawrench/plugin-elevenlabs"),
  () => import("@infrawrench/plugin-fireworks"),
  () => import("@infrawrench/plugin-gemini"),
  () => import("@infrawrench/plugin-gladia"),
  () => import("@infrawrench/plugin-groq"),
  () => import("@infrawrench/plugin-mistral"),
  () => import("@infrawrench/plugin-openai"),
  () => import("@infrawrench/plugin-openrouter"),
  () => import("@infrawrench/plugin-replicate"),
  () => import("@infrawrench/plugin-revai"),
  () => import("@infrawrench/plugin-speechmatics"),
  () => import("@infrawrench/plugin-together"),
  () => import("@infrawrench/plugin-xai"),
];

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
