import { describe, it, expect } from "vitest";
import {
  pluginManifestSchema,
  resourceTypeDefinitionSchema,
  dashboardCardSchema,
  detailViewSchema,
} from "../validation/index.js";

describe("pluginManifestSchema", () => {
  it("accepts a valid manifest", () => {
    const result = pluginManifestSchema.safeParse({
      id: "digitalocean",
      version: "0.1.0",
      displayName: "DigitalOcean",
      description: "Manage DigitalOcean resources",
      logoSvg: "<svg/>",
      author: "Infrawrench",
      license: "MIT",
      minHostVersion: "0.1.0",
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-MIT license", () => {
    const result = pluginManifestSchema.safeParse({
      id: "bad-plugin",
      version: "0.1.0",
      displayName: "Bad",
      description: "Bad plugin",
      logoSvg: "<svg/>",
      author: "Someone",
      license: "Apache-2.0",
      minHostVersion: "0.1.0",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-kebab-case id", () => {
    const result = pluginManifestSchema.safeParse({
      id: "DigitalOcean",
      version: "0.1.0",
      displayName: "DigitalOcean",
      description: "test",
      logoSvg: "<svg/>",
      author: "x",
      license: "MIT",
      minHostVersion: "0.1.0",
    });
    expect(result.success).toBe(false);
  });
});

describe("resourceTypeDefinitionSchema", () => {
  it("accepts a valid resource type", () => {
    const result = resourceTypeDefinitionSchema.safeParse({
      id: "doks-cluster",
      displayName: "DOKS Cluster",
      pluralDisplayName: "DOKS Clusters",
      description: "A managed Kubernetes cluster on DigitalOcean",
      fields: [
        { key: "name", label: "Name", kind: "string", required: true },
        { key: "region", label: "Region", kind: "enum", required: true, enumValues: ["nyc1", "sfo3"] },
      ],
      outputs: [
        { key: "kubeconfig", label: "Kubeconfig", sensitive: true },
      ],
      dashboardPinnable: true,
    });
    expect(result.success).toBe(true);
  });
});

describe("dashboardCardSchema", () => {
  it("accepts a valid card", () => {
    const result = dashboardCardSchema.safeParse({
      pluginId: "digitalocean",
      resourceTypeId: "doks-cluster",
      resourceId: "abc-123",
      displayName: "prod-cluster",
      status: { kind: "status-dot", status: "healthy", label: "Running" },
    });
    expect(result.success).toBe(true);
  });
});

describe("detailViewSchema", () => {
  it("accepts a detail view with nested sections", () => {
    const result = detailViewSchema.safeParse({
      title: "prod-cluster",
      subtitle: "DOKS · nyc1",
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        {
          kind: "section",
          title: "Details",
          children: [
            { kind: "text", content: "Kubernetes 1.30" },
            { kind: "badge", label: "nyc1", color: "blue" },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    });
    expect(result.success).toBe(true);
  });
});
