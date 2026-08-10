import { describe, expect, it } from "vitest";
import type { ResourceInstance } from "../instance.js";
import type { TerraformExportCapability } from "../terraform.js";
import { tf } from "../terraform.js";
import {
  renderTerraformBundle,
  renderTerraformValue,
  sanitizeTerraformName,
} from "../terraform-hcl.js";
import { exportResourcesToTerraform } from "../terraform-export.js";

function makeResource(overrides: Partial<ResourceInstance>): ResourceInstance {
  return {
    id: "acct:server:1",
    pluginId: "hetzner",
    resourceTypeId: "server",
    accountId: "acct",
    displayName: "web-1",
    fields: {},
    resolvedOutputs: {},
    secretStates: [],
    externalId: "1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const capability: TerraformExportCapability = {
  provider: { name: "hcloud", source: "hetznercloud/hcloud", version: "~> 1.45" },
  providerConfig: { token: tf.ref("var.hcloud_token") },
  variables: [{ name: "hcloud_token", sensitive: true, description: "API token" }],
  supportedResourceTypeIds: ["server"],
  mapResource(resource) {
    const name = String(resource.fields["name"] ?? "");
    if (!name) return null;
    return {
      resource: {
        type: "hcloud_server",
        name,
        attributes: { name: tf.str(name), server_type: tf.str("cx22") },
        importId: resource.externalId,
      },
    };
  },
};

describe("sanitizeTerraformName", () => {
  it("lowercases and replaces invalid characters", () => {
    expect(sanitizeTerraformName("Web Server #1 (prod)")).toBe("web_server_1_prod");
  });
  it("prefixes names that start with a digit", () => {
    expect(sanitizeTerraformName("1db")).toBe("r_1db");
  });
  it("falls back for empty results", () => {
    expect(sanitizeTerraformName("***")).toBe("resource");
  });
});

describe("renderTerraformValue", () => {
  it("escapes strings including template sequences", () => {
    expect(renderTerraformValue(tf.str('a"b\n${x}'))).toBe('"a\\"b\\n$${x}"');
  });
  it("renders refs unquoted", () => {
    expect(renderTerraformValue(tf.ref("var.token"))).toBe("var.token");
  });
  it("renders maps and lists", () => {
    expect(renderTerraformValue(tf.list([tf.num(1), tf.bool(false)]))).toBe("[1, false]");
    expect(renderTerraformValue(tf.map({ id: tf.str("abc") }))).toBe('{\n  id = "abc"\n}');
  });
});

describe("renderTerraformBundle", () => {
  it("renders required_providers, variables, provider, and resources", () => {
    const bundle = renderTerraformBundle([
      {
        capability,
        results: [
          capability.mapResource(makeResource({ fields: { name: "web-1" } }))!,
          capability.mapResource(makeResource({ fields: { name: "web 1" }, externalId: "2" }))!,
        ],
      },
    ]);
    expect(bundle.hcl).toContain('source  = "hetznercloud/hcloud"');
    expect(bundle.hcl).toContain('variable "hcloud_token"');
    expect(bundle.hcl).toContain("sensitive = true");
    expect(bundle.hcl).toContain('provider "hcloud" {\n  token = var.hcloud_token\n}');
    // duplicate sanitized names get deduplicated
    expect(bundle.resources.map((r) => r.address)).toEqual([
      "hcloud_server.web_1",
      "hcloud_server.web_1_2",
    ]);
    expect(bundle.hcl).toContain("terraform import hcloud_server.web_1 1");
  });

  it("returns empty output when there is nothing to render", () => {
    expect(renderTerraformBundle([]).hcl).toBe("");
    expect(renderTerraformBundle([{ capability, results: [] }]).hcl).toBe("");
  });
});

describe("exportResourcesToTerraform", () => {
  it("splits exported and unsupported resources", () => {
    const outcome = exportResourcesToTerraform(
      [
        makeResource({ fields: { name: "web-1" } }),
        makeResource({ id: "acct:volume:9", resourceTypeId: "volume", displayName: "vol" }),
        makeResource({ id: "acct:server:3", displayName: "broken", fields: {} }),
        makeResource({ id: "x", pluginId: "unknown", displayName: "other" }),
      ],
      (pluginId) => (pluginId === "hetzner" ? capability : undefined),
    );
    expect(outcome.exported).toHaveLength(1);
    expect(outcome.exported[0]).toMatchObject({
      id: "acct:server:1",
      address: "hcloud_server.web_1",
      importId: "1",
    });
    expect(outcome.unsupported).toHaveLength(3);
    const reasons = outcome.unsupported.map((u) => u.reason);
    expect(reasons).toContain("No Terraform mapping for this resource type yet");
    expect(reasons).toContain("Plugin has no Terraform mapping yet");
    expect(reasons).toContain("Stored state is missing fields required by the Terraform provider");
    expect(outcome.hcl).toContain('resource "hcloud_server" "web_1"');
  });
});
