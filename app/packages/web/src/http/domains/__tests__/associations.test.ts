import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

const { mockSelect, mockInsert, mockDelete, mockDb, mockEncryption } = vi.hoisted(() => {
  const select = vi.fn();
  const insert = vi.fn();
  const del = vi.fn();
  return {
    mockSelect: select,
    mockInsert: insert,
    mockDelete: del,
    mockDb: () => ({ db: { select, insert, delete: del } }),
    mockEncryption: () => ({
      encrypt: vi.fn().mockResolvedValue({ ciphertext: "enc", iv: "iv" }),
      buildAad: vi.fn().mockReturnValue("aad"),
    }),
  };
});
vi.mock("@/db/client", mockDb);
vi.mock("@/services/encryption", mockEncryption);
// The secret-field upserts live in server-core and import its own db /
// encryption modules directly, not the web re-export shims: stub both
// spellings so the two paths share one mock.
vi.mock("@infrawrench/server-core/db/client", mockDb);
vi.mock("@infrawrench/server-core/encryption", mockEncryption);

vi.mock("uuid", () => ({ v4: () => "assoc-uuid-1" }));

const { mockLoadPlugins, mockGetClient } = vi.hoisted(() => ({
  mockLoadPlugins: vi.fn(),
  mockGetClient: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/plugins/loader", () => ({ loadPlugins: mockLoadPlugins }));
vi.mock("@/services/plugin-clients", () => ({ getClientForAccount: mockGetClient }));

const { associationsDomain } = await import("@/http/domains/associations/index");
const buildApp = () =>
  buildTestApi(associationsDomain, { basePath: "/api/org/org-1/associations" });

/**
 * Stub the org-scoped resource lookups. The handler runs two: consumer first,
 * then provider. Pass one array to answer both the same way, or two to answer
 * them differently.
 */
function resourceExists(rows: unknown[], providerRows: unknown[] = rows) {
  const queue = [rows, providerRows];
  mockSelect.mockImplementation(() => {
    const result = queue.shift() ?? [];
    const limit = vi.fn().mockResolvedValue(result);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    return { from };
  });
}

/**
 * Answer each `select` in turn, whether the query ends in `.limit()` or is
 * awaited straight off `.where()`.
 */
function selects(...results: unknown[][]) {
  const queue = [...results];
  mockSelect.mockImplementation(() => {
    const result = queue.shift() ?? [];
    const where = vi.fn(() =>
      Object.assign(Promise.resolve(result), { limit: vi.fn().mockResolvedValue(result) }),
    );
    return { from: vi.fn().mockReturnValue({ where }) };
  });
}

function setupUpsert() {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  mockInsert.mockReturnValue({ values });
  return values;
}

describe("Association routes", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("POST /", () => {
    it("stamps a sync_version so /pull can return the row", async () => {
      // Nothing bumped these, so every association sat at the default 0 and
      // `syncVersion > lastSyncVersion` was false for any real watermark.
      resourceExists([{ id: "r1" }]);
      const values = setupUpsert();
      const res = await buildApp().request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consumerResourceId: "r1",
          consumerFieldKey: "DB_URL",
          providerResourceId: "p1",
          providerOutputKey: "uri",
          providerPluginId: "pg",
          providerResourceTypeId: "db",
          providerAccountId: "a1",
        }),
      });
      expect(res.status).toBe(200);
      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({ syncVersion: expect.anything() }),
      );
    });

    it("returns 404 when the provider resource is in another org", async () => {
      // `provider_resource_id` is an FK with ON DELETE RESTRICT, so accepting a
      // foreign one lets a caller pin a row the other org then cannot delete.
      resourceExists([{ id: "r1" }], []);
      const res = await buildApp().request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consumerResourceId: "r1",
          consumerFieldKey: "DB_URL",
          providerResourceId: "someone-elses-resource",
          providerOutputKey: "uri",
          providerPluginId: "pg",
          providerResourceTypeId: "db",
          providerAccountId: "a1",
        }),
      });
      expect(res.status).toBe(404);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("returns 404 when the consumer resource is not in the org", async () => {
      resourceExists([]);
      const res = await buildApp().request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consumerResourceId: "r1",
          consumerFieldKey: "DB_URL",
          providerResourceId: "p1",
          providerOutputKey: "uri",
          providerPluginId: "pg",
          providerResourceTypeId: "db",
          providerAccountId: "a1",
        }),
      });
      expect(res.status).toBe(404);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("upserts the association and secret field state", async () => {
      resourceExists([{ id: "r1" }]);
      setupUpsert();
      const res = await buildApp().request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consumerResourceId: "r1",
          consumerFieldKey: "DB_URL",
          providerResourceId: "p1",
          providerOutputKey: "uri",
          providerPluginId: "pg",
          providerResourceTypeId: "db",
          providerAccountId: "a1",
        }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
      // associations + secretFieldStates upserts
      expect(mockInsert).toHaveBeenCalledTimes(2);
    });

    it("points the field at the provider's stored plugin, type and account, not the body's", async () => {
      // The reconciler resolves the output with these, and leaked-secret
      // matches name the account: a body that disagreed with the row would
      // point both at the wrong place.
      resourceExists(
        [{ id: "r1" }],
        [{ id: "p1", pluginId: "neon", resourceTypeId: "neon-branch", accountId: "acc-real" }],
      );
      const values = setupUpsert();
      const res = await buildApp().request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consumerResourceId: "r1",
          consumerFieldKey: "DB_URL",
          providerResourceId: "p1",
          providerOutputKey: "uri",
          providerPluginId: "pg",
          providerResourceTypeId: "db",
          providerAccountId: "acc-wrong",
        }),
      });
      expect(res.status).toBe(200);
      expect(values).toHaveBeenLastCalledWith(
        expect.objectContaining({
          resourceId: "r1",
          fieldKey: "DB_URL",
          resolutionKind: "output-ref",
          sourcePluginId: "neon",
          sourceResourceTypeId: "neon-branch",
          sourceResourceId: "p1",
          sourceAccountId: "acc-real",
          sourceOutputKey: "uri",
        }),
      );
    });

    it("accepts a request without the deprecated provider fields", async () => {
      resourceExists(
        [{ id: "r1" }],
        [{ id: "p1", pluginId: "neon", resourceTypeId: "neon-branch", accountId: "acc-real" }],
      );
      const values = setupUpsert();
      const res = await buildApp().request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consumerResourceId: "r1",
          consumerFieldKey: "DB_URL",
          providerResourceId: "p1",
          providerOutputKey: "uri",
        }),
      });
      expect(res.status).toBe(200);
      expect(values).toHaveBeenLastCalledWith(
        expect.objectContaining({ sourcePluginId: "neon", sourceAccountId: "acc-real" }),
      );
    });
  });

  describe("GET /candidates", () => {
    const pgTab = {
      pluginId: "postgres",
      tabLabel: "PostgreSQL",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      showWhen: { fieldKey: "engine", equals: "pg" },
    };
    const plugins = [
      {
        plugin: {
          manifest: { id: "digitalocean", logoSvg: "<svg>do</svg>" },
          resourceTypes: [{ id: "managed-database", peerIntegrations: [pgTab] }],
        },
      },
      { plugin: { manifest: { id: "postgres", logoSvg: "<svg>pg</svg>" }, resourceTypes: [] } },
    ];
    const consumer = {
      id: "acct-pg:database:main",
      pluginId: "postgres",
      resourceTypeId: "database",
      accountId: "acct-pg",
    };

    it("lists stored resources whose outputs feed the field, with their plugin's logo", async () => {
      mockLoadPlugins.mockResolvedValue(plugins);
      selects(
        [consumer],
        [
          {
            id: "acct-do:managed-database:1",
            pluginId: "digitalocean",
            resourceTypeId: "managed-database",
            accountId: "acct-do",
            displayName: "orders",
            fields: { engine: "pg" },
          },
          {
            id: "acct-do:managed-database:2",
            pluginId: "digitalocean",
            resourceTypeId: "managed-database",
            accountId: "acct-do",
            displayName: "cache",
            fields: { engine: "redis" },
          },
        ],
      );
      const res = await buildApp().request(
        `/candidates?resourceId=${encodeURIComponent(consumer.id)}&fieldKey=connectionString`,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([
        {
          resourceId: "acct-do:managed-database:1",
          pluginId: "digitalocean",
          resourceTypeId: "managed-database",
          accountId: "acct-do",
          displayName: "orders",
          outputKey: "connectionString",
          pluginLogoSvg: "<svg>do</svg>",
        },
      ]);
    });

    it("answers an empty list without a query when no plugin feeds the field", async () => {
      mockLoadPlugins.mockResolvedValue(plugins);
      selects([consumer]);
      const res = await buildApp().request(
        `/candidates?resourceId=${encodeURIComponent(consumer.id)}&fieldKey=rootPassword`,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
      expect(mockSelect).toHaveBeenCalledTimes(1);
    });

    it("returns 404 when the resource is not in the org", async () => {
      selects([]);
      const res = await buildApp().request("/candidates?resourceId=r1&fieldKey=connectionString");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /literal", () => {
    it("returns 404 when resource is missing", async () => {
      resourceExists([]);
      const res = await buildApp().request("/literal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceId: "r1", fieldKey: "K", plaintextValue: "v" }),
      });
      expect(res.status).toBe(404);
    });

    it("encrypts the literal and deletes any prior association", async () => {
      resourceExists([{ id: "r1" }]);
      setupUpsert();
      const where = vi.fn().mockResolvedValue(undefined);
      mockDelete.mockReturnValue({ where });

      const res = await buildApp().request("/literal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceId: "r1", fieldKey: "API_KEY", plaintextValue: "secret" }),
      });
      expect(res.status).toBe(200);
      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(mockDelete).toHaveBeenCalledTimes(1);
    });

    const cloudSql = {
      id: "acct-gcp:cloudsql-instance:db1",
      pluginId: "gcp",
      resourceTypeId: "cloudsql-instance",
      accountId: "acct-gcp",
    };

    it("applies the value upstream before storing it", async () => {
      selects([cloudSql]);
      setupUpsert();
      mockDelete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
      const applySecretReroll = vi.fn().mockResolvedValue(undefined);
      mockGetClient.mockResolvedValueOnce({
        plugin: { manifest: { id: "gcp" } },
        client: { applySecretReroll },
      });
      const res = await buildApp().request("/literal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resourceId: cloudSql.id,
          fieldKey: "rootPassword",
          plaintextValue: "n3w",
        }),
      });
      expect(res.status).toBe(200);
      expect(applySecretReroll).toHaveBeenCalledWith(
        "cloudsql-instance",
        cloudSql.id,
        "acct-gcp",
        "rootPassword",
        "n3w",
      );
      expect(mockInsert).toHaveBeenCalledTimes(1);
    });

    it("answers 502 and stores nothing when the provider refuses the value", async () => {
      selects([cloudSql]);
      setupUpsert();
      mockGetClient.mockResolvedValueOnce({
        plugin: { manifest: { id: "gcp" } },
        client: { applySecretReroll: vi.fn().mockRejectedValue(new Error("password too short")) },
      });
      const res = await buildApp().request("/literal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resourceId: cloudSql.id,
          fieldKey: "rootPassword",
          plaintextValue: "x",
        }),
      });
      expect(res.status).toBe(502);
      expect(JSON.stringify(await res.json())).toContain("password too short");
      expect(mockInsert).not.toHaveBeenCalled();
      expect(mockDelete).not.toHaveBeenCalled();
    });
  });
});
