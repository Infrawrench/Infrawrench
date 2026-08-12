import { describe, expect, it } from "vitest";
import type { ResourceInstance } from "../instance.js";
import type { TerraformExportCapability } from "../terraform.js";
import { tf } from "../terraform.js";
import {
  renderTerraformBundle,
  renderTerraformValue,
  sanitizeTerraformName,
} from "../terraform-hcl.js";
import {
  NO_IMPORT_ID_REASON,
  exportResourcesForAdoption,
  exportResourcesToTerraform,
  renderTerraformImportBlocks,
} from "../terraform-export.js";

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
  it("renders empty nested blocks without an equals sign", () => {
    const bundle = renderTerraformBundle([
      {
        capability: {
          ...capability,
          provider: { name: "azurerm", source: "hashicorp/azurerm", version: "~> 5.0" },
          providerConfig: {
            features: tf.block(),
            subscription_id: tf.ref("var.azure_subscription_id"),
          },
          variables: [{ name: "azure_subscription_id" }],
        },
        results: [capability.mapResource(makeResource({ fields: { name: "web-1" } }))!],
      },
    ]);
    expect(bundle.hcl).toContain(
      'provider "azurerm" {\n  features {}\n  subscription_id = var.azure_subscription_id\n}',
    );
    expect(bundle.hcl).not.toContain("features =");
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

describe("renderTerraformImportBlocks", () => {
  const exported = () =>
    exportResourcesToTerraform([makeResource({ fields: { name: "web-1" } })], () => capability)
      .exported;

  it("emits a Terraform 1.5+ import block per adoptable resource", () => {
    const hcl = renderTerraformImportBlocks(exported());
    expect(hcl).toContain("import {");
    expect(hcl).toContain("to = hcloud_server.web_1");
    expect(hcl).toContain('id = "1"');
  });

  it("emits nothing when no resource carries an import id", () => {
    const noIds = exportResourcesToTerraform(
      [makeResource({ externalId: "", fields: { name: "web-2" } })],
      () => capability,
    );
    expect(renderTerraformImportBlocks(noIds.exported)).toBe("");
  });
});

describe("exportResourcesForAdoption", () => {
  /** One importable resource and one the provider gives no import id for. */
  const mixed = () =>
    exportResourcesForAdoption(
      [
        makeResource({ fields: { name: "web-1" } }),
        makeResource({
          id: "acct:server:2",
          externalId: "",
          displayName: "no-id",
          fields: { name: "web-2" },
        }),
      ],
      () => capability,
    );

  it("puts the import blocks ahead of the configuration", () => {
    const { hcl } = mixed();
    expect(hcl.indexOf("import {")).toBeLessThan(hcl.indexOf('resource "hcloud_server"'));
  });

  // The regression: a stanza with no matching import block is a *create*.
  // Handing that to someone told to run `terraform plan` either fails with
  // already-exists or builds a second copy of a resource they already have.
  it("never declares a resource it cannot import", () => {
    const { hcl } = mixed();
    expect(hcl).toContain('resource "hcloud_server" "web_1"');
    expect(hcl).not.toContain("web_2");
    // Every declared resource has an import block, and vice versa.
    expect(hcl.match(/^resource "/gm)).toHaveLength(1);
    expect(hcl.match(/^import \{/gm)).toHaveLength(1);
  });

  it("reports the unimportable resource with a reason instead of dropping it silently", () => {
    const { unsupported } = mixed();
    expect(unsupported).toContainEqual({
      id: "acct:server:2",
      displayName: "no-id",
      pluginId: "hetzner",
      resourceTypeId: "server",
      reason: NO_IMPORT_ID_REASON,
    });
  });

  it("leaves it out of `exported` too, so no caller thinks it shipped", () => {
    const { exported } = mixed();
    expect(exported.map((e) => e.id)).toEqual(["acct:server:1"]);
  });

  it("produces an empty document rather than an unrunnable one when nothing is importable", () => {
    const outcome = exportResourcesForAdoption(
      [makeResource({ externalId: "", fields: { name: "web-2" } })],
      () => capability,
    );
    expect(outcome.hcl).toBe("");
    expect(outcome.exported).toEqual([]);
    expect(outcome.unsupported.map((u) => u.reason)).toEqual([NO_IMPORT_ID_REASON]);
  });

  it("keeps reporting genuinely unmappable resources alongside unimportable ones", () => {
    const outcome = exportResourcesForAdoption(
      [
        makeResource({ fields: { name: "web-1" } }),
        makeResource({ id: "x", pluginId: "unknown", displayName: "other" }),
        makeResource({ id: "acct:server:2", externalId: "", fields: { name: "web-2" } }),
      ],
      (pluginId) => (pluginId === "hetzner" ? capability : undefined),
    );
    const reasons = outcome.unsupported.map((u) => u.reason);
    expect(reasons).toContain("Plugin has no Terraform mapping yet");
    expect(reasons).toContain(NO_IMPORT_ID_REASON);
    expect(outcome.exported).toHaveLength(1);
  });

  it("does not leave dedup suffixes behind when a colliding resource is dropped", () => {
    // Both map to the local name `web`; the unimportable one is dropped, so the
    // survivor must not keep the `_2` it would have needed to avoid it.
    const outcome = exportResourcesForAdoption(
      [
        makeResource({ id: "acct:server:1", externalId: "", fields: { name: "web" } }),
        makeResource({ id: "acct:server:2", externalId: "2", fields: { name: "web" } }),
      ],
      () => capability,
    );
    expect(outcome.exported.map((e) => e.address)).toEqual(["hcloud_server.web"]);
    expect(outcome.hcl).toContain("to = hcloud_server.web\n");
  });
});
