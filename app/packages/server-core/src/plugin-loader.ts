import type { Plugin, PluginRegistry } from "@infrawrench/plugin-base";
import { pluginManifestSchema } from "@infrawrench/plugin-base";
import registry from "./blessed-plugins.json";

// Static imports — keep plugin registration eager so esbuild bundles them all
import { plugin as awsPlugin } from "@infrawrench/plugin-aws";
import { plugin as cloudflarePlugin } from "@infrawrench/plugin-cloudflare";
import { plugin as digitaloceanPlugin } from "@infrawrench/plugin-digitalocean";
import { plugin as dockerPlugin } from "@infrawrench/plugin-docker";
import { plugin as gcpPlugin } from "@infrawrench/plugin-gcp";
import { plugin as hetznerPlugin } from "@infrawrench/plugin-hetzner";
import { plugin as kubernetesPlugin } from "@infrawrench/plugin-kubernetes";
import { plugin as memcachedPlugin } from "@infrawrench/plugin-memcached";
import { plugin as mongodbPlugin } from "@infrawrench/plugin-mongodb";
import { plugin as mysqlPlugin } from "@infrawrench/plugin-mysql";
import { plugin as mssqlPlugin } from "@infrawrench/plugin-mssql";
import { plugin as neonPlugin } from "@infrawrench/plugin-neon";
import { plugin as ovhPlugin } from "@infrawrench/plugin-ovh";
import { plugin as postgresPlugin } from "@infrawrench/plugin-postgres";
import { plugin as redisPlugin } from "@infrawrench/plugin-redis";
import { plugin as scalewayPlugin } from "@infrawrench/plugin-scaleway";
import { plugin as sshPlugin } from "@infrawrench/plugin-ssh";
import { plugin as databricksPlugin } from "@infrawrench/plugin-databricks";
import { plugin as tursoPlugin } from "@infrawrench/plugin-turso";
import { plugin as planetscalePlugin } from "@infrawrench/plugin-planetscale";
import { plugin as azurePlugin } from "@infrawrench/plugin-azure";
import { plugin as flyPlugin } from "@infrawrench/plugin-fly";
import { plugin as vercelPlugin } from "@infrawrench/plugin-vercel";
import { plugin as netlifyPlugin } from "@infrawrench/plugin-netlify";
import { plugin as cloudinaryPlugin } from "@infrawrench/plugin-cloudinary";
import { plugin as clickhousePlugin } from "@infrawrench/plugin-clickhouse";

const blessedRegistry = registry as PluginRegistry;

const PLUGIN_MODULES: Record<string, Plugin> = {
  "@infrawrench/plugin-aws": awsPlugin,
  "@infrawrench/plugin-cloudflare": cloudflarePlugin,
  "@infrawrench/plugin-digitalocean": digitaloceanPlugin,
  "@infrawrench/plugin-docker": dockerPlugin,
  "@infrawrench/plugin-gcp": gcpPlugin,
  "@infrawrench/plugin-hetzner": hetznerPlugin,
  "@infrawrench/plugin-kubernetes": kubernetesPlugin,
  "@infrawrench/plugin-memcached": memcachedPlugin,
  "@infrawrench/plugin-mongodb": mongodbPlugin,
  "@infrawrench/plugin-mysql": mysqlPlugin,
  "@infrawrench/plugin-mssql": mssqlPlugin,
  "@infrawrench/plugin-neon": neonPlugin,
  "@infrawrench/plugin-ovh": ovhPlugin,
  "@infrawrench/plugin-postgres": postgresPlugin,
  "@infrawrench/plugin-redis": redisPlugin,
  "@infrawrench/plugin-scaleway": scalewayPlugin,
  "@infrawrench/plugin-ssh": sshPlugin,
  "@infrawrench/plugin-databricks": databricksPlugin,
  "@infrawrench/plugin-turso": tursoPlugin,
  "@infrawrench/plugin-planetscale": planetscalePlugin,
  "@infrawrench/plugin-azure": azurePlugin,
  "@infrawrench/plugin-fly": flyPlugin,
  "@infrawrench/plugin-vercel": vercelPlugin,
  "@infrawrench/plugin-netlify": netlifyPlugin,
  "@infrawrench/plugin-cloudinary": cloudinaryPlugin,
  "@infrawrench/plugin-clickhouse": clickhousePlugin,
};

export interface LoadedPlugin {
  plugin: Plugin;
  registryEntry: (typeof blessedRegistry.entries)[number];
}

let _loaded: LoadedPlugin[] | null = null;

/**
 * Load and validate all blessed plugins.
 * Results are cached after the first call.
 */
export async function loadPlugins(): Promise<LoadedPlugin[]> {
  if (_loaded) return _loaded;

  const loaded: LoadedPlugin[] = [];

  for (const entry of blessedRegistry.entries) {
    const plugin = PLUGIN_MODULES[entry.packageName];
    if (!plugin) {
      console.warn(`[plugin-loader] No module registered for "${entry.packageName}" — skipping`);
      continue;
    }

    const result = pluginManifestSchema.safeParse(plugin.manifest);
    if (!result.success) {
      console.error(
        `[plugin-loader] Invalid manifest for "${entry.packageName}":`,
        result.error.flatten(),
      );
      continue;
    }

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
