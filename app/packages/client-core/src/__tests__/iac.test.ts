import { describe, expect, it } from "vitest";
import type {
  ResourceInstance,
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import {
  IAC_OMITTED,
  IAC_REDACTED,
  IAC_STATE_LIMITS,
  TerraformStateParseError,
  deriveTerraformTypeMap,
  normalizeComparableValue,
  parseTerraformStateDocument,
  reconcileTerraformState,
} from "../iac";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

// client-core's dependency on plugin-base is type-only by convention, so the
// fixtures build `TerraformValue`s by hand rather than importing `tf`.
const str = (value: string): TerraformValue => ({ kind: "string", value });
const bool = (value: boolean): TerraformValue => ({ kind: "bool", value });
const ref = (expr: string): TerraformValue => ({ kind: "ref", expr });

/**
 * A miniature plugin export capability with the same shape the real ones have:
 * a couple of resource types, `null` when a required field is missing, and one
 * type whose mapper needs a field shape a probe cannot fake.
 */
const demoCapability: TerraformExportCapability = {
  provider: { name: "demo", source: "example/demo", version: "~> 1.0" },
  providerConfig: { token: ref("var.demo_token") },
  variables: [{ name: "demo_token", sensitive: true }],
  supportedResourceTypeIds: ["server", "bucket", "picky"],
  mapResource(resource): TerraformExportResult | null {
    switch (resource.resourceTypeId) {
      case "server": {
        const size = String(resource.fields["size"] ?? "");
        if (!size) return null;
        return {
          resource: {
            type: "demo_server",
            name: resource.displayName,
            attributes: {
              name: str(resource.displayName),
              size: str(size),
              backups: bool(resource.fields["backups"] === true),
            },
            importId: resource.externalId,
          },
        };
      }
      case "bucket":
        return {
          resource: {
            type: "demo_bucket",
            name: resource.displayName,
            attributes: { name: str(resource.displayName) },
            importId: resource.externalId,
          },
        };
      case "picky": {
        // Needs a field the probe cannot invent — the reverse mapping for this
        // type is deliberately underivable.
        const raw = resource.fields["spec"];
        if (typeof raw !== "string") return null;
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length === 0) return null;
        return {
          resource: { type: "demo_picky", name: resource.displayName, attributes: {} },
        };
      }
      default:
        return null;
    }
  },
};

const capabilityFor = (pluginId: string) => (pluginId === "demo" ? demoCapability : undefined);

function resource(overrides: Partial<ResourceInstance> & { id: string }): ResourceInstance {
  return {
    pluginId: "demo",
    resourceTypeId: "server",
    accountId: "acct-1",
    displayName: "web",
    fields: {},
    resolvedOutputs: {},
    secretStates: [],
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

/** Raw `.tfstate`, format version 4. */
const tfstateFixture = {
  version: 4,
  terraform_version: "1.9.5",
  serial: 17,
  lineage: "3f2e-lineage",
  resources: [
    {
      mode: "managed",
      type: "demo_server",
      name: "web",
      provider: 'provider["registry.terraform.io/example/demo"]',
      instances: [
        {
          index_key: 0,
          schema_version: 1,
          attributes: {
            id: "srv-1",
            name: "web",
            size: "s-1vcpu",
            backups: false,
            root_password: "hunter2",
          },
          sensitive_attributes: [[{ type: "get_attr", value: "root_password" }]],
        },
      ],
    },
    {
      mode: "data",
      type: "demo_image",
      name: "ubuntu",
      instances: [{ attributes: { id: "img-1" } }],
    },
    {
      module: "module.legacy",
      mode: "managed",
      type: "demo_bucket",
      name: "old",
      instances: [{ attributes: { id: "bkt-gone" } }],
    },
  ],
};

/** `terraform show -json` state representation. */
const showJsonFixture = {
  format_version: "1.0",
  terraform_version: "1.9.5",
  values: {
    root_module: {
      resources: [
        {
          address: "demo_server.web",
          mode: "managed",
          type: "demo_server",
          name: "web",
          provider_name: "registry.terraform.io/example/demo",
          values: {
            id: "srv-1",
            name: "web",
            size: "s-1vcpu",
            backups: false,
            root_password: "hunter2",
          },
          sensitive_values: { root_password: true },
        },
      ],
      child_modules: [
        {
          address: "module.legacy",
          resources: [
            {
              address: "module.legacy.demo_bucket.old",
              mode: "managed",
              type: "demo_bucket",
              name: "old",
              values: { id: "bkt-gone", name: "old" },
            },
          ],
        },
      ],
    },
  },
};

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

describe("parseTerraformStateDocument", () => {
  it("reads a version 4 tfstate, including modules and data sources", () => {
    const parsed = parseTerraformStateDocument(JSON.stringify(tfstateFixture));
    expect(parsed.format).toBe("tfstate");
    expect(parsed.formatVersion).toBe("4");
    expect(parsed.terraformVersion).toBe("1.9.5");
    expect(parsed.serial).toBe(17);
    expect(parsed.lineage).toBe("3f2e-lineage");
    expect(parsed.resources.map((r) => r.address)).toEqual([
      "demo_server.web[0]",
      "data.demo_image.ubuntu",
      "module.legacy.demo_bucket.old",
    ]);
    expect(parsed.dataSourceCount).toBe(1);
    expect(parsed.resources[0]?.providerName).toBe("registry.terraform.io/example/demo");
    expect(parsed.resources[0]?.identifiers).toEqual(["srv-1"]);
  });

  it("reads `terraform show -json` output, recursing into child modules", () => {
    const parsed = parseTerraformStateDocument(JSON.stringify(showJsonFixture));
    expect(parsed.format).toBe("show-json");
    expect(parsed.formatVersion).toBe("1.0");
    expect(parsed.resources.map((r) => r.address)).toEqual([
      "demo_server.web",
      "module.legacy.demo_bucket.old",
    ]);
    expect(parsed.resources[1]?.module).toBe("module.legacy");
  });

  it("both formats agree on the attributes they extract", () => {
    const fromState = parseTerraformStateDocument(JSON.stringify(tfstateFixture)).resources[0];
    const fromShow = parseTerraformStateDocument(JSON.stringify(showJsonFixture)).resources[0];
    expect(fromShow?.attributes).toEqual(fromState?.attributes);
  });

  it("redacts attributes the state marks sensitive, in both formats", () => {
    for (const fixture of [tfstateFixture, showJsonFixture]) {
      const parsed = parseTerraformStateDocument(JSON.stringify(fixture));
      const server = parsed.resources[0];
      expect(server?.attributes["root_password"]).toBe(IAC_REDACTED);
      expect(server?.redactedAttributeKeys).toEqual(["root_password"]);
      expect(parsed.redactedAttributeCount).toBe(1);
      expect(JSON.stringify(parsed)).not.toContain("hunter2");
    }
  });

  it("redacts a whole top-level attribute when a nested leaf is sensitive", () => {
    const parsed = parseTerraformStateDocument(
      JSON.stringify({
        format_version: "1.0",
        values: {
          root_module: {
            resources: [
              {
                mode: "managed",
                type: "demo_server",
                name: "web",
                values: { id: "srv-1", config: { user: "app", password: "s3cret" } },
                sensitive_values: { config: { password: true } },
              },
            ],
          },
        },
      }),
    );
    expect(parsed.resources[0]?.attributes["config"]).toBe(IAC_REDACTED);
    expect(JSON.stringify(parsed)).not.toContain("s3cret");
  });

  it("version-checks rather than assuming", () => {
    expect(() => parseTerraformStateDocument(JSON.stringify({ version: 3, modules: [] }))).toThrow(
      TerraformStateParseError,
    );
    expect(() => parseTerraformStateDocument(JSON.stringify({ version: 5 }))).toThrow(
      /newer than the version 4 layout/,
    );
    expect(() =>
      parseTerraformStateDocument(JSON.stringify({ format_version: "2.0", values: {} })),
    ).toThrow(/not supported/);
  });

  it("rejects documents that are not state at all", () => {
    expect(() => parseTerraformStateDocument("not json")).toThrow(/not valid JSON/);
    expect(() => parseTerraformStateDocument(JSON.stringify({ hello: "world" }))).toThrow(
      /neither `version`/,
    );
    expect(() => parseTerraformStateDocument(JSON.stringify([1, 2, 3]))).toThrow(
      /not a JSON object/,
    );
    expect(() =>
      parseTerraformStateDocument(JSON.stringify({ format_version: "1.0", planned_values: {} })),
    ).toThrow(/A plan file is not a state document/);
  });

  it("enforces the upload size bound before parsing", () => {
    const oversized = " ".repeat(IAC_STATE_LIMITS.maxDocumentBytes + 1);
    const error = (() => {
      try {
        parseTerraformStateDocument(oversized);
        return null;
      } catch (e) {
        return e as TerraformStateParseError;
      }
    })();
    expect(error?.code).toBe("too-large");
  });

  it("truncates an attribute value too long to be a useful diff", () => {
    const long = "x".repeat(IAC_STATE_LIMITS.maxAttributeValueChars + 500);
    const parsed = parseTerraformStateDocument(
      JSON.stringify({
        version: 4,
        resources: [
          {
            mode: "managed",
            type: "demo_server",
            name: "web",
            instances: [{ attributes: { id: "srv-1", user_data: long } }],
          },
        ],
      }),
    );
    expect(String(parsed.resources[0]?.attributes["user_data"]).length).toBe(
      IAC_STATE_LIMITS.maxAttributeValueChars,
    );
    // A truncated value is not the value the state carried, so it must be
    // excluded from comparison or the truncation itself reads as drift.
    expect(parsed.resources[0]?.redactedAttributeKeys).toContain("user_data");
    expect(parsed.omittedAttributeCount).toBe(1);
    // …but it is not *sensitive*, and the two counts must not be conflated.
    expect(parsed.redactedAttributeCount).toBe(0);
  });

  it("registers an oversized structure so it is never compared", () => {
    const huge = Array.from({ length: 400 }, (_, i) => ({
      cidr: `10.0.${i}.0/24`,
      note: "x".repeat(20),
    }));
    const parsed = parseTerraformStateDocument(
      JSON.stringify({
        version: 4,
        resources: [
          {
            mode: "managed",
            type: "demo_server",
            name: "web",
            instances: [{ attributes: { id: "srv-1", rules: huge, size: "s-1vcpu" } }],
          },
        ],
      }),
    );
    const entry = parsed.resources[0];
    expect(entry?.attributes["rules"]).toBe(IAC_OMITTED);
    expect(entry?.redactedAttributeKeys).toContain("rules");
    // Untouched attributes are unaffected.
    expect(entry?.attributes["size"]).toBe("s-1vcpu");
    expect(entry?.redactedAttributeKeys).not.toContain("size");
    expect(parsed.omittedAttributeCount).toBe(1);
    expect(parsed.redactedAttributeCount).toBe(0);
    expect(parsed.warnings.join(" ")).toContain("too large to store");
  });

  it("keeps the sensitive and oversized counts apart while excluding both", () => {
    const huge = { blob: "y".repeat(IAC_STATE_LIMITS.maxAttributeValueChars + 100) };
    const parsed = parseTerraformStateDocument(
      JSON.stringify({
        format_version: "1.0",
        values: {
          root_module: {
            resources: [
              {
                mode: "managed",
                type: "demo_server",
                name: "web",
                values: { id: "srv-1", policy: huge, password: "hunter2" },
                sensitive_values: { password: true },
              },
            ],
          },
        },
      }),
    );
    expect(parsed.redactedAttributeCount).toBe(1);
    expect(parsed.omittedAttributeCount).toBe(1);
    expect(parsed.resources[0]?.redactedAttributeKeys.sort()).toEqual(["password", "policy"]);
  });
});

/* ------------------------------------------------------------------ *
 * Reverse mapping
 * ------------------------------------------------------------------ */

describe("deriveTerraformTypeMap", () => {
  it("derives the reverse mapping from the export mappers themselves", () => {
    const derived = deriveTerraformTypeMap([{ pluginId: "demo", capability: demoCapability }]);
    expect(derived.byTerraformType.get("demo_server")).toEqual([
      { pluginId: "demo", resourceTypeId: "server" },
    ]);
    expect(derived.byResourceType.get("demo/bucket")).toEqual(["demo_bucket"]);
  });

  it("reports what it cannot derive instead of guessing", () => {
    const derived = deriveTerraformTypeMap([{ pluginId: "demo", capability: demoCapability }]);
    expect(derived.underivable).toEqual([
      { pluginId: "demo", resourceTypeId: "picky", reason: expect.any(String) },
    ]);
    expect(derived.byTerraformType.has("demo_picky")).toBe(false);
  });

  it("skips plugins with no export capability", () => {
    const derived = deriveTerraformTypeMap([{ pluginId: "other", capability: undefined }]);
    expect(derived.byTerraformType.size).toBe(0);
    expect(derived.underivable).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

describe("reconcileTerraformState", () => {
  const typeMap = deriveTerraformTypeMap([{ pluginId: "demo", capability: demoCapability }]);

  const inventory = [
    // Matches the state exactly.
    resource({
      id: "r-managed",
      displayName: "web",
      externalId: "srv-1",
      fields: { size: "s-1vcpu", backups: false },
    }),
    // Matches, but somebody resized it in the console.
    resource({
      id: "r-drifted",
      displayName: "api",
      externalId: "srv-2",
      fields: { size: "s-4vcpu", backups: false },
    }),
    // Nobody ever wrote Terraform for this one.
    resource({
      id: "r-unmanaged",
      displayName: "scratch",
      externalId: "srv-3",
      fields: { size: "s-1vcpu" },
    }),
  ];

  const state = parseTerraformStateDocument(
    JSON.stringify({
      version: 4,
      resources: [
        {
          mode: "managed",
          type: "demo_server",
          name: "web",
          instances: [
            { attributes: { id: "srv-1", name: "web", size: "s-1vcpu", backups: false } },
          ],
        },
        {
          mode: "managed",
          type: "demo_server",
          name: "api",
          instances: [
            { attributes: { id: "srv-2", name: "api", size: "s-1vcpu", backups: false } },
          ],
        },
        {
          mode: "managed",
          type: "demo_bucket",
          name: "gone",
          instances: [{ attributes: { id: "bkt-gone", name: "gone" } }],
        },
        { mode: "data", type: "demo_image", name: "ubuntu", instances: [{ attributes: {} }] },
      ],
    }),
  );

  const result = reconcileTerraformState({
    stateResources: state.resources,
    inventory,
    capabilityFor,
    typeMap,
  });

  const byId = (id: string) => result.resources.find((r) => r.resourceId === id);

  it("classifies a matched, identical resource as managed", () => {
    const entry = byId("r-managed");
    expect(entry?.status).toBe("managed");
    expect(entry?.terraformAddress).toBe("demo_server.web");
    expect(entry?.terraformType).toBe("demo_server");
    expect(entry?.matchedBy).toBe("import-id");
    expect(entry?.drift).toEqual([]);
  });

  it("classifies a matched resource whose live fields differ as drifted", () => {
    const entry = byId("r-drifted");
    expect(entry?.status).toBe("drifted");
    expect(entry?.terraformAddress).toBe("demo_server.api");
    // `from` is the state, `to` is what is actually running.
    expect(entry?.drift).toEqual([{ field: "size", from: "s-1vcpu", to: "s-4vcpu" }]);
  });

  it("classifies an inventory resource absent from state as unmanaged", () => {
    const entry = byId("r-unmanaged");
    expect(entry?.status).toBe("unmanaged");
    expect(entry?.terraformAddress).toBeNull();
    expect(entry?.matchedBy).toBeNull();
  });

  it("reports a state entry with no inventory match as its own category", () => {
    expect(result.stateOnly).toEqual([
      {
        address: "demo_bucket.gone",
        terraformType: "demo_bucket",
        identifiers: ["bkt-gone"],
        candidates: [{ pluginId: "demo", resourceTypeId: "bucket" }],
        reason: "no-inventory-match",
      },
    ]);
  });

  it("ignores data sources but counts them", () => {
    expect(result.summary.dataSourcesIgnored).toBe(1);
    expect(result.summary.stateResources).toBe(3);
  });

  it("totals every bucket", () => {
    expect(result.summary).toMatchObject({
      inventoryTotal: 3,
      managed: 1,
      drifted: 1,
      unmanaged: 1,
      stateOnly: 1,
      undiffable: 0,
    });
  });

  it("says a state entry's terraform type is unknown when nothing maps to it", () => {
    const foreign = parseTerraformStateDocument(
      JSON.stringify({
        version: 4,
        resources: [
          {
            mode: "managed",
            type: "acme_widget",
            name: "w",
            instances: [{ attributes: { id: "w-1" } }],
          },
        ],
      }),
    );
    const out = reconcileTerraformState({
      stateResources: foreign.resources,
      inventory: [],
      capabilityFor,
      typeMap,
    });
    expect(out.stateOnly[0]?.reason).toBe("unknown-terraform-type");
    expect(out.stateOnly[0]?.candidates).toEqual([]);
  });

  it("never reports drift for a resource it could not map, and says why", () => {
    const out = reconcileTerraformState({
      stateResources: state.resources,
      inventory: [
        resource({
          id: "r-nomapping",
          pluginId: "other",
          resourceTypeId: "thing",
          displayName: "web",
          externalId: "srv-1",
        }),
      ],
      capabilityFor,
      typeMap,
    });
    const entry = out.resources[0];
    expect(entry?.unmappableReason).toBe("This plugin has no Terraform mapping yet");
    // Still matched — an unmappable resource can carry an external id.
    expect(entry?.status).toBe("managed");
    expect(entry?.matchedBy).toBe("identifier");
    expect(entry?.drift).toEqual([]);
    expect(out.summary.undiffable).toBe(1);
  });

  it("refuses an ambiguous identifier-only match rather than guessing", () => {
    const ambiguous = parseTerraformStateDocument(
      JSON.stringify({
        version: 4,
        resources: [
          {
            mode: "managed",
            type: "demo_server",
            name: "a",
            instances: [{ attributes: { id: "dup" } }],
          },
          {
            mode: "managed",
            type: "demo_bucket",
            name: "b",
            instances: [{ attributes: { id: "dup" } }],
          },
        ],
      }),
    );
    const out = reconcileTerraformState({
      stateResources: ambiguous.resources,
      inventory: [
        resource({
          id: "r",
          pluginId: "other",
          resourceTypeId: "thing",
          externalId: "dup",
        }),
      ],
      capabilityFor,
      typeMap,
    });
    expect(out.resources[0]?.status).toBe("unmanaged");
    expect(out.stateOnly).toHaveLength(2);
  });

  it("does not read a redacted attribute as drift", () => {
    const withSecret = parseTerraformStateDocument(
      JSON.stringify({
        version: 4,
        resources: [
          {
            mode: "managed",
            type: "demo_server",
            name: "api",
            instances: [
              {
                // Same resource as the drifted case above, except the size the
                // state carries is sensitive — so the one field that differs
                // is one we deliberately never stored.
                attributes: { id: "srv-2", name: "api", size: "s-1vcpu", backups: false },
                sensitive_attributes: [[{ type: "get_attr", value: "size" }]],
              },
            ],
          },
        ],
      }),
    );
    const out = reconcileTerraformState({
      stateResources: withSecret.resources,
      inventory: [inventory[1]!],
      capabilityFor,
      typeMap,
    });
    expect(out.resources[0]?.status).toBe("managed");
    expect(out.resources[0]?.drift).toEqual([]);
  });

  // The regression: a value we clamped is not the value the state carried, so
  // comparing it reports drift caused by our own storage limit.
  it("does not read a clamped oversized attribute as drift", () => {
    const clamped = parseTerraformStateDocument(
      JSON.stringify({
        version: 4,
        resources: [
          {
            mode: "managed",
            type: "demo_server",
            name: "api",
            instances: [
              {
                attributes: {
                  id: "srv-2",
                  name: "api",
                  // Longer than the limit, so only a prefix is stored.
                  size: "s".repeat(IAC_STATE_LIMITS.maxAttributeValueChars + 200),
                  backups: false,
                },
              },
            ],
          },
        ],
      }),
    );
    expect(clamped.resources[0]?.redactedAttributeKeys).toContain("size");
    const out = reconcileTerraformState({
      stateResources: clamped.resources,
      inventory: [inventory[1]!],
      capabilityFor,
      typeMap,
    });
    expect(out.resources[0]?.drift).toEqual([]);
    expect(out.resources[0]?.status).toBe("managed");
  });

  it("does not read a numeric string as drift against a number", () => {
    expect(normalizeComparableValue("8")).toBe(8);
    expect(normalizeComparableValue("s-1vcpu")).toBe("s-1vcpu");
    expect(normalizeComparableValue({ a: ["2", "x"] })).toEqual({ a: [2, "x"] });
  });

  it("matches identically whichever document format the state arrived in", () => {
    const fromShow = reconcileTerraformState({
      stateResources: parseTerraformStateDocument(JSON.stringify(showJsonFixture)).resources,
      inventory: [inventory[0]!],
      capabilityFor,
      typeMap,
    });
    expect(fromShow.resources[0]?.status).toBe("managed");
    expect(fromShow.resources[0]?.terraformAddress).toBe("demo_server.web");
  });
});
