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
  assemblyai: { apiKey: "test-assemblyai-key", region: "us" },
  aws: { accessKeyId: "AKIATEST", secretAccessKey: "testsecret", region: "us-east-1" },
  gcp: {
    serviceAccountJson: JSON.stringify({
      type: "service_account",
      project_id: "test",
      private_key_id: "test-key-id",
      private_key: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n",
      client_email: "test@test.iam.gserviceaccount.com",
      client_id: "1234567890",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
    }),
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
  mssql: {
    connectionString:
      "mssql://user:pass@localhost:1433/db?encrypt=true&trustServerCertificate=true",
  },
  mongodb: { connectionString: "mongodb://localhost:27017/test" },
  redis: { connectionString: "redis://localhost:6379" },
  memcached: { connectionString: "localhost:11211" },
  kafka: { connectionString: "kafka://localhost:9092" },
  openai: { apiKey: "sk-proj-test", adminApiKey: "sk-admin-test" },
  openrouter: { managementKey: "sk-or-v1-test-management", apiKey: "sk-or-v1-test-inference" },
  opensearch: { endpoint: "https://search.example.com:9200", authMode: "basic" },
  neon: { apiKey: "neon_test_key" },
  planetscale: {
    serviceTokenId: "test-id",
    serviceTokenSecret: "test-secret",
    organizationName: "test-org",
  },
  turso: { apiToken: "test-token", organizationName: "test-org" },
  docker: { dockerHost: "unix:///var/run/docker.sock" },
  cloudflare: { apiToken: "test-cf-token" },
  speechmatics: {
    apiKey: "test-speechmatics-key",
    region: "eu1",
    managementToken: "test-speechmatics-management-token",
  },
  ssh: {
    host: "192.168.1.1",
    port: "22",
    username: "root",
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----",
  },
  databricks: { host: "https://adb-test.azuredatabricks.net", token: "dapi-test" },
  deepgram: { apiKey: "test-deepgram-key" },
  azure: {
    tenantId: "test-tenant-id",
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    subscriptionId: "test-subscription-id",
  },
  fly: { apiToken: "test-fly-token", orgSlug: "personal" },
  vercel: { accessToken: "test-vercel-token", teamId: "" },
  netlify: { accessToken: "nfp_test_token" },
  cloudinary: {
    cloudName: "test-cloud",
    apiKey: "123456789012345",
    apiSecret: "test-api-secret",
  },
  anthropic: { apiKey: "sk-ant-api03-test-key", adminApiKey: "sk-ant-admin01-test-key" },
  cohere: { apiKey: "test-cohere-key" },
  deepseek: { apiKey: "sk-test-deepseek-key" },
  elevenlabs: { apiKey: "sk_test_elevenlabs_key" },
  gemini: { apiKey: "AIzaSyTestGeminiApiKey0000000000000000000" },
  gladia: { apiKey: "test-gladia-key" },
  groq: { apiKey: "gsk_test_groq_key" },
  mistral: { apiKey: "test-mistral-key", adminApiKey: "test-mistral-admin-key" },
  cartesia: { apiKey: "sk_car_test_key", adminApiKey: "sk_car_admin_test_key" },
  clickhouse: {
    apiKeyId: "test-key-id",
    apiKeySecret: "test-key-secret",
    organizationId: "12345678-1234-1234-1234-123456789abc",
    chHost: "test.us-east-1.aws.clickhouse.cloud",
    chUser: "default",
    chPassword: "test-password",
  },
  fireworks: { apiKey: "fw_test_fireworks_key", accountId: "test-account" },
  replicate: { apiToken: "r8_test_replicate_token" },
  revai: { accessToken: "test-revai-access-token", region: "us" },
  together: { apiKey: "test-together-key" },
  xai: { apiKey: "xai-test-inference-key", managementKey: "xai-test-management-key" },
  uploadthing: { apiKey: "sk_live_EXAMPLE_NOT_A_REAL_KEY" },
  workos: { apiKey: "sk_test_workos_key" },
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

      if (plugin.manifest.preflight) {
        // Not enforceable at registration (no client exists yet), so the
        // bundled-plugin contract tests pin it down here instead.
        it("manifest.preflight → client has verifyCredentials", () => {
          expect(typeof client.verifyCredentials).toBe("function");
        });

        if (plugin.manifest.preflight.templateFormat) {
          it("preflight.templateFormat → plugin has policyTemplate", () => {
            expect(typeof plugin.policyTemplate).toBe("function");
          });
        }
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

/**
 * Standard rendering tests for every plugin.
 * Validates that renderDetail and renderSidebarItem produce valid output
 * for each resource type. Plugins can pass extra test cases via `extras`.
 */
export function runPluginRenderingTests(
  plugin: Plugin,
  extras?: (client: ReturnType<Plugin["createClient"]>, plugin: Plugin) => void,
) {
  const client = plugin.createClient(makeMockCredentials(plugin.manifest.id));

  describe(`${plugin.manifest.displayName} rendering`, () => {
    for (const rt of plugin.resourceTypes) {
      describe(rt.id, () => {
        const resource = createMockResource(plugin.manifest.id, rt);

        it("renderDetail returns valid schema", () => {
          const schema = client.renderDetail(resource);
          const result = detailViewSchema.safeParse(schema);
          if (!result.success) console.error(rt.id, result.error.issues);
          expect(result.success).toBe(true);
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
