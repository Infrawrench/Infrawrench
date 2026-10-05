import { describe, it, expect } from "vitest";
import { loadPlugins } from "@/plugins/loader";

describe("plugin loader", () => {
  it("loads all 76 plugins successfully", async () => {
    const plugins = await loadPlugins();
    expect(plugins).toHaveLength(76);
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
      "newrelic",
      "metronome",
      "circleci",
      "mssql",
      "fly",
      "vercel",
      "netlify",
      "cloudinary",
      "clickhouse",
      "mongodb",
      "mongodb-atlas",
      "mysql",
      "postgres",
      "redis",
      "scaleway",
      "sentry",
      "ssh",
      "tailscale",
      "cloudflare",
      "crusoe",
      "baseten",
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
      "elastic-cloud",
      "anthropic",
      "anyscale",
      "assemblyai",
      "cartesia",
      "cohere",
      "coralogix",
      "cursor",
      "datadog",
      "deepgram",
      "deepseek",
      "devin",
      "elevenlabs",
      "fastly",
      "fireworks",
      "confluent-cloud",
      "gemini",
      "github",
      "gladia",
      "grafana-cloud",
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
      "twilio",
    ];
    expect([...ids].sort()).toEqual([...expected].sort());
  });
});
