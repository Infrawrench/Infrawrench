import { describe, it, expect, beforeAll } from "vitest";
import { loadPlugins } from "@/plugins/loader";
import type { LoadedPlugin } from "@/plugins/loader";
import { makeMockCredentials } from "@infrawrench/plugin-base/test-harness";

/**
 * Derive feature flags from a plugin manifest the same way resource-detail.ts does.
 * These flags come from the manifest declarations, not the client instance.
 */
function deriveFeatureFlags(loaded: LoadedPlugin) {
  const manifest = loaded.plugin.manifest;
  const hasResourceSqlDriver = loaded.plugin.resourceTypes.some((rt) => rt.resourceSqlDriver);
  return {
    hasSqlEditor: !!manifest.sqlDriver || hasResourceSqlDriver,
    hasKvConsole: !!manifest.kvDriver,
    kvDriverName: manifest.kvDriver?.driver,
    hasDockerActions: !!manifest.dockerDriver,
    hasSshTerminal: loaded.plugin.resourceTypes.some((rt) => rt.supportsTerminal),
    hasSftpBrowser: loaded.plugin.resourceTypes.some((rt) => rt.supportsSftpBrowser),
    hasStorageBrowser: loaded.plugin.resourceTypes.some((rt) => rt.supportsStorageBrowser),
  };
}

describe("plugin feature flags", () => {
  let plugins: LoadedPlugin[];

  beforeAll(async () => {
    plugins = await loadPlugins();
  });

  function getPlugin(id: string): LoadedPlugin {
    const p = plugins.find((p) => p.plugin.manifest.id === id);
    if (!p) throw new Error(`Plugin "${id}" not found`);
    return p;
  }

  it("postgres plugin has hasSqlEditor", () => {
    const flags = deriveFeatureFlags(getPlugin("postgres"));
    expect(flags.hasSqlEditor).toBe(true);
  });

  it("mysql plugin has hasSqlEditor", () => {
    const flags = deriveFeatureFlags(getPlugin("mysql"));
    expect(flags.hasSqlEditor).toBe(true);
  });

  it("redis plugin has hasKvConsole with redis driver", () => {
    const flags = deriveFeatureFlags(getPlugin("redis"));
    expect(flags.hasKvConsole).toBe(true);
    expect(flags.kvDriverName).toBe("redis");
  });

  it("memcached plugin has hasKvConsole with memcached driver", () => {
    const flags = deriveFeatureFlags(getPlugin("memcached"));
    expect(flags.hasKvConsole).toBe(true);
    expect(flags.kvDriverName).toBe("memcached");
  });

  it("mongodb plugin has hasKvConsole with mongodb driver", () => {
    const flags = deriveFeatureFlags(getPlugin("mongodb"));
    expect(flags.hasKvConsole).toBe(true);
    expect(flags.kvDriverName).toBe("mongodb");
  });

  it("docker plugin has hasDockerActions", () => {
    const flags = deriveFeatureFlags(getPlugin("docker"));
    expect(flags.hasDockerActions).toBe(true);
  });

  it("ssh plugin has hasSshTerminal", () => {
    const loaded = getPlugin("ssh");
    const creds = makeMockCredentials("ssh");
    const client = loaded.plugin.createClient(creds);
    expect(typeof client.getSshConfig).toBe("function");
  });

  it("aws plugin does not have kvConsole or dockerActions", () => {
    const flags = deriveFeatureFlags(getPlugin("aws"));
    expect(flags.hasKvConsole).toBe(false);
    expect(flags.hasDockerActions).toBe(false);
  });

  it("hetzner plugin does not have sqlEditor or kvConsole", () => {
    const flags = deriveFeatureFlags(getPlugin("hetzner"));
    expect(flags.hasSqlEditor).toBe(false);
    expect(flags.hasKvConsole).toBe(false);
  });

  it("cloudflare plugin has sqlEditor via D1 resource but no kvConsole", () => {
    const flags = deriveFeatureFlags(getPlugin("cloudflare"));
    expect(flags.hasSqlEditor).toBe(true);
    expect(flags.hasKvConsole).toBe(false);
  });

  it("kubernetes plugin does not have sqlEditor or kvConsole", () => {
    const flags = deriveFeatureFlags(getPlugin("kubernetes"));
    expect(flags.hasSqlEditor).toBe(false);
    expect(flags.hasKvConsole).toBe(false);
  });
});
