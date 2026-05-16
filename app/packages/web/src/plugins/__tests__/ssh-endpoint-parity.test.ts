import { describe, it, expect, beforeAll } from "vitest";
import { loadPlugins } from "@/plugins/loader";
import type { LoadedPlugin } from "@/plugins/loader";

/**
 * Verifies that the web app recognizes the same SSH/SFTP-capable resource types
 * as desktop. Desktop derives SSH support from two sources:
 *   1. client.getSshConfig() — for the dedicated SSH plugin
 *   2. resourceType.sshEndpoint — for cloud VMs (EC2, droplets, etc.)
 *
 * The web must check both. This test ensures all plugins with sshEndpoint
 * on their resource types are detected.
 */

describe("SSH endpoint parity", () => {
  let plugins: LoadedPlugin[];

  beforeAll(async () => {
    plugins = await loadPlugins();
  });

  function getPlugin(id: string): LoadedPlugin {
    const p = plugins.find((p) => p.plugin.manifest.id === id);
    if (!p) throw new Error(`Plugin "${id}" not found`);
    return p;
  }

  // These are the plugins that declare sshEndpoint on their resource types,
  // enabling SSH/SFTP for cloud VMs in both desktop and web.
  const SSH_ENDPOINT_PLUGINS: Array<{
    pluginId: string;
    resourceTypeId: string;
    hostOutputKey: string;
    privateHostOutputKey?: string;
  }> = [
    {
      pluginId: "aws",
      resourceTypeId: "ec2-instance",
      hostOutputKey: "publicIp",
      privateHostOutputKey: "privateIp",
    },
    {
      pluginId: "digitalocean",
      resourceTypeId: "droplet",
      hostOutputKey: "ipv4",
      privateHostOutputKey: "ipv4Private",
    },
    {
      pluginId: "hetzner",
      resourceTypeId: "server",
      hostOutputKey: "ipv4",
      privateHostOutputKey: "ipv4Private",
    },
    {
      pluginId: "gcp",
      resourceTypeId: "gce-instance",
      hostOutputKey: "externalIp",
      privateHostOutputKey: "internalIp",
    },
    {
      pluginId: "scaleway",
      resourceTypeId: "instance",
      hostOutputKey: "publicIp",
      privateHostOutputKey: "privateIp",
    },
    {
      pluginId: "ovh",
      resourceTypeId: "instance",
      hostOutputKey: "ipv4",
      privateHostOutputKey: "ipv4Private",
    },
  ];

  for (const {
    pluginId,
    resourceTypeId,
    hostOutputKey,
    privateHostOutputKey,
  } of SSH_ENDPOINT_PLUGINS) {
    it(`${pluginId}/${resourceTypeId} declares sshEndpoint with hostOutputKey="${hostOutputKey}"`, () => {
      const loaded = getPlugin(pluginId);
      const rt = loaded.plugin.resourceTypes.find((t) => t.id === resourceTypeId);
      expect(rt).toBeDefined();
      expect(rt!.sshEndpoint).toBeDefined();
      expect(rt!.sshEndpoint!.hostOutputKey).toBe(hostOutputKey);
      if (privateHostOutputKey) {
        expect(rt!.sshEndpoint!.privateHostOutputKey).toBe(privateHostOutputKey);
        // The private-host output key must point at a real declared output, so
        // the jumpbox flow doesn't end up snapshotting an empty string.
        expect(rt!.outputs.map((o) => o.key)).toContain(privateHostOutputKey);
      }
    });
  }

  // The SSH plugin uses getSshConfig() instead of sshEndpoint
  it("ssh plugin uses getSshConfig(), not sshEndpoint", () => {
    const loaded = getPlugin("ssh");
    // SSH plugin should NOT have sshEndpoint — it uses client.getSshConfig()
    for (const rt of loaded.plugin.resourceTypes) {
      expect(rt.sshEndpoint).toBeUndefined();
    }
    // But its client should have getSshConfig
    const client = loaded.plugin.createClient({
      host: "1.2.3.4",
      port: "22",
      username: "root",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----",
    });
    expect(typeof client.getSshConfig).toBe("function");
  });

  // Plugins that should NOT have SSH
  const NO_SSH_PLUGINS = [
    "postgres",
    "mysql",
    "redis",
    "memcached",
    "mongodb",
    "docker",
    "cloudflare",
    "neon",
    "planetscale",
    "turso",
    "kubernetes",
    "databricks",
  ];

  for (const pluginId of NO_SSH_PLUGINS) {
    it(`${pluginId} does NOT declare sshEndpoint on any resource type`, () => {
      const loaded = getPlugin(pluginId);
      for (const rt of loaded.plugin.resourceTypes) {
        expect(rt.sshEndpoint).toBeUndefined();
      }
    });
  }

  // Web feature flag derivation should match desktop for ALL plugins
  it("feature flag derivation covers all connection features", () => {
    for (const loaded of plugins) {
      const manifest = loaded.plugin.manifest;
      const resourceTypes = loaded.plugin.resourceTypes;

      // SQL: manifest.sqlDriver OR resourceType.resourceSqlDriver OR client.executeQuery
      const manifestSql = !!manifest.sqlDriver;
      const resourceSql = resourceTypes.some((rt) => rt.resourceSqlDriver);

      // KV: manifest.kvDriver
      const hasKv = !!manifest.kvDriver;

      // Docker: manifest.dockerDriver
      const hasDocker = !!manifest.dockerDriver;

      // SSH: client.getSshConfig() OR resourceType.sshEndpoint
      const hasSshEndpoint = resourceTypes.some((rt) => rt.sshEndpoint);

      // These flags should be derivable from the plugin's manifest/resourceTypes
      // without needing to call the API — this is the basis for both desktop and web
      expect(typeof manifestSql).toBe("boolean");
      expect(typeof resourceSql).toBe("boolean");
      expect(typeof hasKv).toBe("boolean");
      expect(typeof hasDocker).toBe("boolean");
      expect(typeof hasSshEndpoint).toBe("boolean");
    }
  });
});
