import type { Plugin } from "@infrawrench/plugin-base";
import { pluginManifestSchema, validatePreflightContract } from "@infrawrench/plugin-base";

declare global {
  /**
   * Defined `true` at build time by the web edge Worker only (its
   * wrangler.jsonc `define`). Never set at runtime.
   */
  var __INFRAWRENCH_EDGE_PLUGINS__: boolean | undefined;
}

/**
 * The plugins to load. On Node (and in the poller Worker) that is
 * `plugin-registry.ts`: every plugin, code and all. The web edge Worker
 * builds with `__INFRAWRENCH_EDGE_PLUGINS__` defined, which turns this into
 * the metadata-only registry: the plugins' code (~26 MiB with the provider
 * SDKs) is what made the web Worker too big for a 128 MB isolate, while most
 * API routes only read manifests. The ternary is load-bearing: esbuild drops
 * the branch the constant rules out, *including its import()*, which an
 * `if`/early-return does not do.
 */
function bundledPlugins(): Promise<readonly Plugin[]> {
  return globalThis.__INFRAWRENCH_EDGE_PLUGINS__
    ? import("./plugin-registry-edge").then((m) => m.EDGE_PLUGINS)
    : import("./plugin-registry").then((m) => m.BUNDLED_PLUGINS);
}

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

  for (const plugin of await bundledPlugins()) {
    const result = pluginManifestSchema.safeParse(plugin.manifest);
    if (!result.success) {
      console.error(
        `[plugin-loader] Invalid manifest for "${plugin.manifest?.id ?? "unknown"}":`,
        result.error.flatten(),
      );
      continue;
    }
    const contractProblem = validatePreflightContract(plugin);
    if (contractProblem) {
      console.error(
        `[plugin-loader] Invalid preflight contract for "${plugin.manifest.id}": ${contractProblem}`,
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
