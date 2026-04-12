import { describe, expect, it } from "vitest";
import { humanizeIdentifier, pluginLabelFromId } from "../utils";

describe("humanizeIdentifier", () => {
  it("humanizes camelCase values", () => {
    expect(humanizeIdentifier("resourceTypeId")).toBe("Resource Type Id");
  });

  it("humanizes snake_case and kebab-case values", () => {
    expect(humanizeIdentifier("resource_type_id")).toBe("Resource Type Id");
    expect(humanizeIdentifier("resource-type-id")).toBe("Resource Type Id");
  });

  it("preserves acronyms while splitting mixed case", () => {
    expect(humanizeIdentifier("AWSRdsInstance")).toBe("AWS Rds Instance");
  });

  it("returns empty string for whitespace-only values", () => {
    expect(humanizeIdentifier("   ")).toBe("");
  });
});

describe("pluginLabelFromId", () => {
  it("maps all known plugin IDs to canonical human labels", () => {
    expect(pluginLabelFromId("aws")).toBe("Amazon Web Services");
    expect(pluginLabelFromId("azure")).toBe("Microsoft Azure");
    expect(pluginLabelFromId("clickhouse")).toBe("ClickHouse");
    expect(pluginLabelFromId("cloudflare")).toBe("Cloudflare");
    expect(pluginLabelFromId("cloudinary")).toBe("Cloudinary");
    expect(pluginLabelFromId("databricks")).toBe("Databricks");
    expect(pluginLabelFromId("digitalocean")).toBe("DigitalOcean");
    expect(pluginLabelFromId("docker")).toBe("Docker");
    expect(pluginLabelFromId("fly")).toBe("Fly.io");
    expect(pluginLabelFromId("gcp")).toBe("Google Cloud");
    expect(pluginLabelFromId("hetzner")).toBe("Hetzner Cloud");
    expect(pluginLabelFromId("kubernetes")).toBe("Kubernetes");
    expect(pluginLabelFromId("memcached")).toBe("Memcached");
    expect(pluginLabelFromId("mongodb")).toBe("MongoDB");
    expect(pluginLabelFromId("mysql")).toBe("MySQL");
    expect(pluginLabelFromId("neon")).toBe("Neon");
    expect(pluginLabelFromId("netlify")).toBe("Netlify");
    expect(pluginLabelFromId("ovh")).toBe("OVHcloud");
    expect(pluginLabelFromId("planetscale")).toBe("PlanetScale");
    expect(pluginLabelFromId("postgres")).toBe("PostgreSQL");
    expect(pluginLabelFromId("redis")).toBe("Redis");
    expect(pluginLabelFromId("scaleway")).toBe("Scaleway");
    expect(pluginLabelFromId("ssh")).toBe("SSH");
    expect(pluginLabelFromId("turso")).toBe("Turso");
    expect(pluginLabelFromId("vercel")).toBe("Vercel");
  });

  it("supports package-style plugin IDs", () => {
    expect(pluginLabelFromId("@infrawrench/plugin-aws")).toBe("Amazon Web Services");
    expect(pluginLabelFromId("plugin-gcp")).toBe("Google Cloud");
  });

  it("falls back to humanized unknown plugin IDs", () => {
    expect(pluginLabelFromId("unknownProviderPlugin")).toBe("Unknown Provider Plugin");
  });
});
