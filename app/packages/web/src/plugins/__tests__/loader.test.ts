import { describe, it, expect } from "vitest";
import { loadPlugins } from "@/plugins/loader";

describe("plugin loader", () => {
  // The first call pays the cold import of every plugin, which takes well over
  // the default timeout on a busy machine; the rest of the file reuses it.
  it("loads all 152 plugins successfully", async () => {
    const plugins = await loadPlugins();
    expect(plugins).toHaveLength(152);
  }, 60_000);

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
      "postmark",
      "runpod",
      "render",
      "stripe",
      "supabase",
      "vultr",
      "resend",
      "convex",
      "railway",
      "gitlab",
      "civo",
      "xata",
      "heroku",
      "pagerduty",
      "bitbucket",
      "cockroachdb-cloud",
      "northflank",
      "upcloud",
      "incident-io",
      "koyeb",
      "sendgrid",
      "lambda-cloud",
      "upstash",
      "mailgun",
      "timescale",
      "exoscale",
      "alibaba-cloud",
      "pinecone",
      "vast-ai",
      "aiven",
      "backblaze-b2",
      "paperspace",
      "datastax-astra",
      "qdrant-cloud",
      "honeycomb",
      "ibm-cloud",
      "dynatrace",
      "wasabi",
      "weaviate-cloud",
      "s3-compatible",
      "couchbase-capella",
      "axiom",
      "algolia",
      "splunk-observability",
      "buildkite",
      "influxdb-cloud",
      "bunny",
      "jfrog",
      "infisical",
      "better-stack",
      "chronosphere",
      "docker-hub",
      "posthog",
      "hcp-terraform",
      "okta",
      "checkly",
      "huggingface",
      "proxmox",
      "hashicorp-vault",
      "auth0",
      "pulumi-cloud",
      "cerebras",
      "sambanova",
      "vsphere",
      "clerk",
      "perplexity",
      "doppler",
      "fal",
      "spacelift",
      "voyage",
      "openstack",
      "rabbitmq",
      "prometheus",
      "nomad",
      "consul",
      "nats",
    ];
    expect([...ids].sort()).toEqual([...expected].sort());
  });
});
