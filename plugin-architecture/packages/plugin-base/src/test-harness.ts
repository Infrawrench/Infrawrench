import { describe, it, expect } from "vitest";
import type { Plugin } from "./manifest.js";
import type { ResourceInstance } from "./instance.js";
import type { ResourceTypeDefinition } from "./resource.js";
import {
  pluginManifestSchema,
  resourceTypeDefinitionSchema,
  detailViewSchema,
} from "./validation/index.js";

const MOCK_CREDENTIALS: Record<string, Record<string, string>> = {
  aws: { accessKeyId: "AKIATEST", secretAccessKey: "testsecret", region: "us-east-1" },
  gcp: {
    serviceAccountJson: '{"type":"service_account","project_id":"test"}',
    project: "test-project",
  },
  digitalocean: { apiToken: "dop_v1_test" },
  hetzner: { apiToken: "test-token" },
  scaleway: { accessKey: "SCWTEST", secretKey: "test-uuid", defaultProjectId: "test-project-id" },
  ovh: {
    applicationKey: "test",
    applicationSecret: "test",
    consumerKey: "test",
    endpoint: "eu",
    projectId: "12345678-abcd-1234-abcd-1234567890ab",
  },
  kubernetes: { kubeconfig: "apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers: []" },
  postgres: { connectionString: "postgresql://user:pass@localhost:5432/db" },
  mysql: { connectionString: "mysql://user:pass@localhost:3306/db" },
  mongodb: { connectionString: "mongodb://localhost:27017/test" },
  redis: { connectionString: "redis://localhost:6379" },
  memcached: { connectionString: "localhost:11211" },
  neon: { apiKey: "neon_test_key" },
  planetscale: {
    serviceTokenId: "test-id",
    serviceTokenSecret: "test-secret",
    organizationName: "test-org",
  },
  turso: { apiToken: "test-token", organizationName: "test-org" },
  docker: { dockerHost: "unix:///var/run/docker.sock" },
  cloudflare: { apiToken: "test-cf-token" },
  ssh: {
    host: "192.168.1.1",
    port: "22",
    username: "root",
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----",
  },
  databricks: { host: "https://adb-test.azuredatabricks.net", token: "dapi-test" },
  azure: {
    tenantId: "test-tenant-id",
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    subscriptionId: "test-subscription-id",
  },
  fly: { apiToken: "test-fly-token", orgSlug: "personal" },
  vercel: { accessToken: "test-vercel-token", teamId: "" },
  netlify: { accessToken: "nfp_test_token" },
};

export function makeMockCredentials(pluginId: string): Record<string, string> {
  const creds = MOCK_CREDENTIALS[pluginId];
  if (!creds) throw new Error(`No mock credentials for plugin "${pluginId}"`);
  return { ...creds };
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

export function runPluginContractTests(plugin: Plugin, credentials?: Record<string, string>) {
  const creds = credentials ?? makeMockCredentials(plugin.manifest.id);

  describe(`${plugin.manifest.displayName} contract`, () => {
    describe("manifest", () => {
      it("passes Zod validation", () => {
        const result = pluginManifestSchema.safeParse(plugin.manifest);
        expect(result.success).toBe(true);
      });

      it("has non-empty credentialFields", () => {
        expect(plugin.manifest.credentialFields.length).toBeGreaterThan(0);
      });

      it("logoSvg starts with <svg", () => {
        expect(plugin.manifest.logoSvg.trimStart()).toMatch(/^<svg/);
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
        it(`${rt.id} passes Zod validation`, () => {
          const result = resourceTypeDefinitionSchema.safeParse(rt);
          expect(result.success).toBe(true);
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
          const result = detailViewSchema.safeParse(schema);
          if (!result.success) {
            console.error(`Detail validation errors for ${rt.id}:`, result.error.issues);
          }
          expect(result.success).toBe(true);
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
      const client = plugin.createClient(creds);

      it("client is defined", () => {
        expect(client).toBeDefined();
      });

      if (plugin.manifest.supportsSecretImport) {
        it("supportsSecretImport → client has importSecret", () => {
          expect(typeof client.importSecret).toBe("function");
        });
      }

      const hasSupportsCreate = plugin.resourceTypes.some((rt) => rt.supportsCreate);
      if (hasSupportsCreate && typeof client.createResource === "function") {
        it("resourceType.supportsCreate → client has createResource", () => {
          expect(typeof client.createResource).toBe("function");
        });
      }

      const hasSupportsTerminal = plugin.resourceTypes.some((rt) => rt.supportsTerminal);
      if (hasSupportsTerminal) {
        it("resourceType.supportsTerminal → client has getSshConfig", () => {
          expect(typeof client.getSshConfig).toBe("function");
        });
      }

      const hasSupportsStorageBrowser = plugin.resourceTypes.some(
        (rt) => rt.supportsStorageBrowser,
      );
      if (hasSupportsStorageBrowser && typeof client.listStorageObjects === "function") {
        it("resourceType.supportsStorageBrowser → client has listStorageObjects", () => {
          expect(typeof client.listStorageObjects).toBe("function");
        });
      }
    });
  });
}
