import type { Plugin } from "@infrawrench/plugin-base";
import { pluginManifestSchema } from "@infrawrench/plugin-base";

// Static imports — keep plugin registration eager so esbuild bundles them all
import { plugin as awsPlugin } from "@infrawrench/plugin-aws";
import { plugin as cloudflarePlugin } from "@infrawrench/plugin-cloudflare";
import { plugin as digitaloceanPlugin } from "@infrawrench/plugin-digitalocean";
import { plugin as dockerPlugin } from "@infrawrench/plugin-docker";
import { plugin as gcpPlugin } from "@infrawrench/plugin-gcp";
import { plugin as hetznerPlugin } from "@infrawrench/plugin-hetzner";
import { plugin as kafkaPlugin } from "@infrawrench/plugin-kafka";
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
import { plugin as opensearchPlugin } from "@infrawrench/plugin-opensearch";
import { plugin as anthropicPlugin } from "@infrawrench/plugin-anthropic";
import { plugin as assemblyaiPlugin } from "@infrawrench/plugin-assemblyai";
import { plugin as cartesiaPlugin } from "@infrawrench/plugin-cartesia";
import { plugin as coherePlugin } from "@infrawrench/plugin-cohere";
import { plugin as deepgramPlugin } from "@infrawrench/plugin-deepgram";
import { plugin as deepseekPlugin } from "@infrawrench/plugin-deepseek";
import { plugin as elevenlabsPlugin } from "@infrawrench/plugin-elevenlabs";
import { plugin as fireworksPlugin } from "@infrawrench/plugin-fireworks";
import { plugin as geminiPlugin } from "@infrawrench/plugin-gemini";
import { plugin as gladiaPlugin } from "@infrawrench/plugin-gladia";
import { plugin as groqPlugin } from "@infrawrench/plugin-groq";
import { plugin as mistralPlugin } from "@infrawrench/plugin-mistral";
import { plugin as openaiPlugin } from "@infrawrench/plugin-openai";
import { plugin as openrouterPlugin } from "@infrawrench/plugin-openrouter";
import { plugin as replicatePlugin } from "@infrawrench/plugin-replicate";
import { plugin as revaiPlugin } from "@infrawrench/plugin-revai";
import { plugin as speechmaticsPlugin } from "@infrawrench/plugin-speechmatics";
import { plugin as togetherPlugin } from "@infrawrench/plugin-together";
import { plugin as xaiPlugin } from "@infrawrench/plugin-xai";

const PLUGINS: Plugin[] = [
  awsPlugin,
  cloudflarePlugin,
  digitaloceanPlugin,
  dockerPlugin,
  gcpPlugin,
  hetznerPlugin,
  kafkaPlugin,
  kubernetesPlugin,
  memcachedPlugin,
  mongodbPlugin,
  mysqlPlugin,
  mssqlPlugin,
  neonPlugin,
  ovhPlugin,
  postgresPlugin,
  redisPlugin,
  scalewayPlugin,
  sshPlugin,
  databricksPlugin,
  tursoPlugin,
  planetscalePlugin,
  azurePlugin,
  flyPlugin,
  vercelPlugin,
  netlifyPlugin,
  cloudinaryPlugin,
  clickhousePlugin,
  opensearchPlugin,
  anthropicPlugin,
  assemblyaiPlugin,
  cartesiaPlugin,
  coherePlugin,
  deepgramPlugin,
  deepseekPlugin,
  elevenlabsPlugin,
  fireworksPlugin,
  geminiPlugin,
  gladiaPlugin,
  groqPlugin,
  mistralPlugin,
  openaiPlugin,
  openrouterPlugin,
  replicatePlugin,
  revaiPlugin,
  speechmaticsPlugin,
  togetherPlugin,
  xaiPlugin,
];

export interface LoadedPlugin {
  plugin: Plugin;
}

let _loaded: LoadedPlugin[] | null = null;

/**
 * Load and validate all bundled plugins.
 * Results are cached after the first call.
 */
export async function loadPlugins(): Promise<LoadedPlugin[]> {
  if (_loaded) return _loaded;

  const loaded: LoadedPlugin[] = [];

  for (const plugin of PLUGINS) {
    const result = pluginManifestSchema.safeParse(plugin.manifest);
    if (!result.success) {
      console.error(
        `[plugin-loader] Invalid manifest for "${plugin.manifest?.id ?? "unknown"}":`,
        result.error.flatten(),
      );
      continue;
    }
    loaded.push({ plugin });
  }

  _loaded = loaded;
  return loaded;
}

/** Get a single loaded plugin by its manifest id */
export async function getPlugin(pluginId: string): Promise<LoadedPlugin | undefined> {
  const plugins = await loadPlugins();
  return plugins.find((p) => p.plugin.manifest.id === pluginId);
}
