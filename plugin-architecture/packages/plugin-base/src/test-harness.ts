import { describe, it, expect } from "vitest";
import type { HostPlugin, HostPluginClient } from "./contract-effect.js";
import type { Plugin } from "./manifest.js";
import type { ResourceInstance } from "./instance.js";
import type { ResourceTypeDefinition } from "./resource.js";
import { clientContractProblems, validatePluginContract } from "./define-plugin.js";
import { hostPlugin } from "./effect.js";
import {
  pluginManifestSchema,
  resourceTypeDefinitionSchema,
  detailViewSchema,
  validate,
} from "./validation/index.js";
import { findUnsafeSvgConstructs } from "./svg-safety.js";

/** Credentials that construct a client without contacting anything. */
export function makeMockCredentials(
  plugin: Pick<Plugin, "testCredentials">,
): Record<string, string> {
  return { ...plugin.testCredentials };
}

export function createMockResource(
  pluginId: string,
  resourceType: ResourceTypeDefinition,
): ResourceInstance {
  const fields: Record<string, string | number | boolean> = {};
  for (const field of resourceType.fields) {
    switch (field.kind) {
      case "string":
        fields[field.key] = `test-${field.key}`;
        break;
      case "number":
        fields[field.key] = 42;
        break;
      case "boolean":
        fields[field.key] = true;
        break;
      case "enum":
        fields[field.key] = field.enumValues?.[0] ?? "default";
        break;
      case "secret":
      case "association":
        fields[field.key] = `mock-${field.key}`;
        break;
      case "password":
        // Write-only: never populated from stored values, so leave it unset to
        // mirror what providers actually return.
        break;
    }
  }

  return {
    id: `mock-${pluginId}-${resourceType.id}-001`,
    pluginId,
    resourceTypeId: resourceType.id,
    accountId: `mock-account-${pluginId}`,
    displayName: `Test ${resourceType.displayName}`,
    fields,
    resolvedOutputs: {},
    secretStates: [],
    externalId: `ext-${resourceType.id}-001`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function runPluginContractTests(contract: Plugin, credentials?: Record<string, string>) {
  const creds = credentials ?? makeMockCredentials(contract);
  const plugin = hostPlugin(contract);

  describe(`${plugin.manifest.displayName} contract`, () => {
    describe("manifest", () => {
      it("passes validation", () => {
        const result = validate(pluginManifestSchema, plugin.manifest);
        expect(result.success ? [] : result.issues).toEqual([]);
      });

      it("has non-empty credentialFields", () => {
        expect(plugin.manifest.credentialFields.length).toBeGreaterThan(0);
      });

      it("logoSvg starts with <svg", () => {
        expect(plugin.manifest.logoSvg.trimStart()).toMatch(/^<svg/);
      });

      // Every host injects this string with `dangerouslySetInnerHTML` and
      // there is no script CSP behind those call sites, so "it looks like a
      // logo" is not enough: it has to be provably inert. The same predicate
      // refines `pluginManifestSchema`, so a failure here is a plugin that
      // would not have loaded; the assertion is repeated at the contract level
      // because this is where it names the offending construct.
      it("logoSvg contains nothing that can execute or fetch", () => {
        expect(findUnsafeSvgConstructs(plugin.manifest.logoSvg)).toEqual([]);
      });

      it("id is lowercase kebab-case", () => {
        expect(plugin.manifest.id).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
      });

      if (plugin.manifest.sqlDriver) {
        it("sqlDriver.credentialKey exists in credentialFields", () => {
          const keys = plugin.manifest.credentialFields.map((f) => f.key);
          expect(keys).toContain(plugin.manifest.sqlDriver!.credentialKey);
        });
      }

      if (plugin.manifest.kvDriver) {
        it("kvDriver.credentialKey exists in credentialFields", () => {
          const keys = plugin.manifest.credentialFields.map((f) => f.key);
          expect(keys).toContain(plugin.manifest.kvDriver!.credentialKey);
        });
      }

      if (plugin.manifest.dockerDriver) {
        it("dockerDriver.credentialKey exists in credentialFields", () => {
          const keys = plugin.manifest.credentialFields.map((f) => f.key);
          expect(keys).toContain(plugin.manifest.dockerDriver!.credentialKey);
        });
      }
    });

    describe("resource types", () => {
      it("has at least one resource type", () => {
        expect(plugin.resourceTypes.length).toBeGreaterThan(0);
      });

      it("resource type IDs are unique", () => {
        const ids = plugin.resourceTypes.map((rt) => rt.id);
        expect(new Set(ids).size).toBe(ids.length);
      });

      for (const rt of plugin.resourceTypes) {
        it(`${rt.id} passes validation`, () => {
          const result = validate(resourceTypeDefinitionSchema, rt);
          expect(result.success ? [] : result.issues).toEqual([]);
        });

        if (rt.parentTypeId) {
          it(`${rt.id} parentTypeId references a sibling type`, () => {
            const siblingIds = plugin.resourceTypes.map((s) => s.id);
            expect(siblingIds).toContain(rt.parentTypeId);
          });
        }
      }
    });

    describe("client", () => {
      it("createClient does not throw", () => {
        expect(() => plugin.createClient(creds)).not.toThrow();
      });

      it("client has required methods", () => {
        const client = plugin.createClient(creds);
        expect(typeof client.listResources).toBe("function");
        expect(typeof client.getResource).toBe("function");
        expect(typeof client.resolveOutput).toBe("function");
        expect(typeof client.renderDetail).toBe("function");
        expect(typeof client.renderSidebarItem).toBe("function");
      });
    });

    describe("renderDetail", () => {
      const client = plugin.createClient(creds);

      for (const rt of plugin.resourceTypes) {
        it(`returns valid DetailViewSchema for ${rt.id}`, () => {
          const mockResource = createMockResource(plugin.manifest.id, rt);
          const schema = client.renderDetail(mockResource);
          const result = validate(detailViewSchema, schema);
          expect(result.success ? [] : result.issues).toEqual([]);
        });
      }
    });

    describe("renderSidebarItem", () => {
      const client = plugin.createClient(creds);

      for (const rt of plugin.resourceTypes) {
        it(`returns { id, label } for ${rt.id}`, () => {
          const mockResource = createMockResource(plugin.manifest.id, rt);
          const item = client.renderSidebarItem(mockResource);
          expect(item).toBeDefined();
          expect(typeof item.id).toBe("string");
          expect(item.id.length).toBeGreaterThan(0);
          expect(typeof item.label).toBe("string");
          expect(item.label.length).toBeGreaterThan(0);
        });
      }
    });

    describe("optional method consistency", () => {
      it("implements everything the manifest and resource types declare", () => {
        const client = plugin.createClient(creds);
        expect(clientContractProblems(contract, client)).toEqual([]);
        expect(validatePluginContract(contract)).toEqual([]);
      });

      const tokenFormats = plugin.manifest.tokenFormats ?? [];
      if (tokenFormats.length > 0) {
        it("tokenFormats are unique and name declared credential fields", () => {
          const keys = new Set(plugin.manifest.credentialFields.map((f) => f.key));
          const ids = tokenFormats.map((t) => t.id);
          expect(new Set(ids).size).toBe(ids.length);
          for (const format of tokenFormats) {
            expect(format.scannerTypes.length + (format.prefixes?.length ?? 0)).toBeGreaterThan(0);
            for (const field of format.credentialFields ?? []) expect(keys.has(field)).toBe(true);
          }
        });
      }
    });
  });
}

/**
 * Standard rendering tests for every plugin.
 * Validates that renderDetail and renderSidebarItem produce valid output
 * for each resource type. Plugins can pass extra test cases via `extras`.
 */
export function runPluginRenderingTests(
  contract: Plugin,
  extras?: (client: HostPluginClient, plugin: HostPlugin) => void,
) {
  const plugin = hostPlugin(contract);
  const client = plugin.createClient(makeMockCredentials(contract));

  describe(`${plugin.manifest.displayName} rendering`, () => {
    for (const rt of plugin.resourceTypes) {
      describe(rt.id, () => {
        const resource = createMockResource(plugin.manifest.id, rt);

        it("renderDetail returns valid schema", () => {
          const schema = client.renderDetail(resource);
          const result = validate(detailViewSchema, schema);
          expect(result.success ? [] : result.issues).toEqual([]);
        });

        it("renderDetail has non-empty title", () => {
          const schema = client.renderDetail(resource);
          expect(schema.title).toBeTruthy();
        });

        it("renderDetail has at least one section", () => {
          const schema = client.renderDetail(resource);
          expect(schema.sections.length).toBeGreaterThan(0);
        });

        it("renderSidebarItem returns valid shape", () => {
          const item = client.renderSidebarItem(resource);
          expect(typeof item.id).toBe("string");
          expect(item.id.length).toBeGreaterThan(0);
          expect(typeof item.label).toBe("string");
          expect(item.label.length).toBeGreaterThan(0);
        });
      });
    }

    extras?.(client, plugin);
  });
}
