import { describe, it, expect } from "vitest";
import { loadPlugins } from "@/plugins/loader";

describe("plugin loader", () => {
  it("loads all 51 plugins successfully", async () => {
    const plugins = await loadPlugins();
    expect(plugins).toHaveLength(51);
  });

  it("each plugin has a valid manifest with required fields", async () => {
    const plugins = await loadPlugins();
    for (const { plugin } of plugins) {
      expect(plugin.manifest.id).toBeTruthy();
      expect(plugin.manifest.displayName).toBeTruthy();
      expect(plugin.manifest.logoSvg).toBeTruthy();
      expect(Array.isArray(plugin.manifest.credentialFields)).toBe(true);
    }
  });

  it("all plugin IDs are unique", async () => {
    const plugins = await loadPlugins();
    const ids = plugins.map((p) => p.plugin.manifest.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every plugin exposes createClient and at least one resource type", async () => {
    const plugins = await loadPlugins();
    for (const { plugin } of plugins) {
      expect(typeof plugin.createClient).toBe("function");
      expect(plugin.resourceTypes.length).toBeGreaterThan(0);
    }
  });

  it("expected plugin IDs are present", async () => {
    const plugins = await loadPlugins();
    const ids = plugins.map((p) => p.plugin.manifest.id);
    const expected = [
      "aws",
      "gcp",
      "docker",
      "digitalocean",
      "hetzner",
      "kubernetes",
      "memcached",
      "neon",
      "circleci",
      "mongodb",
      "mysql",
      "postgres",
      "redis",
      "scaleway",
      "ssh",
      "tailscale",
      "cloudflare",
      "crusoe",
      "ovh",
      "oracle-cloud",
      "databricks",
      "snowflake",
      "depot",
      "coreweave",
      "turso",
      "planetscale",
      "redis-cloud",
      "azure",
      "kafka",
      "linode",
      "opensearch",
      "anthropic",
      "assemblyai",
      "cartesia",
      "cohere",
      "cursor",
      "deepgram",
      "deepseek",
      "devin",
      "elevenlabs",
      "fireworks",
      "confluent-cloud",
      "gemini",
      "github",
      "gladia",
      "groq",
      "mistral",
      "modal",
      "openai",
      "openrouter",
      "replicate",
      "revai",
      "speechmatics",
      "temporal-cloud",
      "together",
      "xai",
      "uploadthing",
      "workos",
    ];
    for (const id of expected) {
      expect(ids).toContain(id);
    }
  });
});
