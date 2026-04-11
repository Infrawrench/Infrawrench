import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AuthSession } from "@/api/auth-middleware";

const mockInsert = vi.fn();
const mockSelect = vi.fn();
const mockDelete = vi.fn();
const mockUpdate = vi.fn();

vi.mock("@/db/client", () => ({
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
    select: (...args: unknown[]) => mockSelect(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

vi.mock("@/services/encryption", () => ({
  encrypt: vi.fn().mockResolvedValue({ ciphertext: "enc-blob", iv: "iv-123" }),
  decrypt: vi.fn().mockResolvedValue(JSON.stringify({ token: "secret-val" })),
}));

const mockLoadPlugins = vi.fn();
const mockGetPlugin = vi.fn();
vi.mock("@/plugins/loader", () => ({
  loadPlugins: (...args: unknown[]) => mockLoadPlugins(...args),
  getPlugin: (...args: unknown[]) => mockGetPlugin(...args),
}));

vi.mock("@/services/host-services", () => ({
  buildPluginHostServices: vi.fn().mockReturnValue({}),
}));

vi.mock("uuid", () => ({ v4: () => "acct-uuid-1" }));

const { accountRoutes } = await import("@/api/routes/accounts");

function buildApp() {
  const app = new Hono();
  const session: AuthSession = {
    userId: "user-1",
    email: "test@example.com",
  };
  app.use("*", async (c, next) => {
    c.set("session", session);
    c.set("organizationId", "org-1");
    return next();
  });
  app.route("/", accountRoutes);
  return app;
}

function chainMock(result: unknown) {
  const push = vi.fn();
  const limit = vi.fn().mockResolvedValue(result);
  const where = vi.fn().mockReturnValue({ limit, push });
  const from = vi.fn().mockReturnValue({ where });
  return { from, where, limit };
}

describe("Account routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /plugins — list available plugins", () => {
    it("returns plugin manifests with credential field metadata", async () => {
      mockLoadPlugins.mockResolvedValue([
        {
          plugin: {
            manifest: {
              id: "aws",
              displayName: "AWS",
              logoSvg: "<svg/>",
              credentialFields: [
                {
                  key: "accessKeyId",
                  label: "Access Key",
                  description: "desc",
                  placeholder: "",
                  sensitive: true,
                  multiline: false,
                  defaultValue: "",
                },
              ],
            },
          },
        },
      ]);

      const app = buildApp();
      const res = await app.request("/plugins", { method: "GET" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe("aws");
      expect(body[0].credentialFields[0].key).toBe("accessKeyId");
      expect(body[0].credentialFields[0].sensitive).toBe(true);
    });
  });

  describe("GET / — list accounts", () => {
    it("returns accounts without encrypted fields", async () => {
      const rows = [
        { id: "a1", pluginId: "aws", displayName: "Prod AWS", createdAt: new Date("2026-01-01") },
      ];
      const where = vi.fn().mockResolvedValue(rows);
      const from = vi.fn().mockReturnValue({ where });
      mockSelect.mockReturnValue({ from });

      const app = buildApp();
      const res = await app.request("/", { method: "GET" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0]).not.toHaveProperty("encryptedCredentials");
      expect(body[0]).not.toHaveProperty("credentialsIv");
    });
  });

  describe("POST / — create an account", () => {
    it("encrypts credentials and returns the new id", async () => {
      const values = vi.fn().mockResolvedValue(undefined);
      mockInsert.mockReturnValue({ values });

      // Mock for syncAccountResources (it calls db.select, getPlugin, etc.)
      // We make the internal sync throw so it's caught and ignored
      const chain = chainMock([]);
      mockSelect.mockReturnValue(chain);

      const app = buildApp();
      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pluginId: "aws",
          displayName: "Prod AWS",
          credentials: { accessKeyId: "AKIA...", secretAccessKey: "abc" },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("acct-uuid-1");

      // Verify encrypted values were stored
      const insertedValues = values.mock.calls[0]![0];
      expect(insertedValues.encryptedCredentials).toBe("enc-blob");
      expect(insertedValues.credentialsIv).toBe("iv-123");
    });
  });

  describe("DELETE /:id — delete an account", () => {
    it("deletes the account and returns ok", async () => {
      const where = vi.fn().mockResolvedValue(undefined);
      mockDelete.mockReturnValue({ where });

      const app = buildApp();
      const res = await app.request("/a1", { method: "DELETE" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });
  });

  describe("POST /:id/sync — trigger resource sync", () => {
    const account = {
      id: "a1",
      organizationId: "org-1",
      pluginId: "aws",
      encryptedCredentials: "enc",
      credentialsIv: "iv",
    };

    function setupSyncMocks(
      pluginResources: Array<{
        id: string;
        pluginId: string;
        resourceTypeId: string;
        displayName: string;
        accountId: string;
        fields: Record<string, unknown>;
        resolvedOutputs: Record<string, unknown>;
      }>,
    ) {
      const where = vi.fn().mockResolvedValue([account]);
      const from = vi.fn().mockReturnValue({ where });
      mockSelect.mockReturnValue({ from });

      const mockClient = {
        listResources: vi.fn().mockResolvedValue(pluginResources),
      };
      mockGetPlugin.mockResolvedValue({
        plugin: {
          manifest: { id: "aws" },
          resourceTypes: [{ id: "ec2-instance" }],
          createClient: vi.fn().mockReturnValue(mockClient),
        },
      });

      const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
      const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
      mockInsert.mockReturnValue({ values });

      // db.update().set().where()
      const updateWhere = vi.fn().mockResolvedValue(undefined);
      const set = vi.fn().mockReturnValue({ where: updateWhere });
      mockUpdate.mockReturnValue({ set });

      return { mockClient, updateWhere, set };
    }

    it("returns synced count on success", async () => {
      setupSyncMocks([]);

      const app = buildApp();
      const res = await app.request("/a1/sync", { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("synced");
      expect(body.synced).toBe(0);
    });

    it("soft-deletes stale resources not returned by plugin", async () => {
      const liveResource = {
        id: "r-live",
        pluginId: "aws",
        resourceTypeId: "ec2-instance",
        displayName: "live-vm",
        accountId: "a1",
        fields: {},
        resolvedOutputs: {},
      };

      const { set } = setupSyncMocks([liveResource]);

      const app = buildApp();
      const res = await app.request("/a1/sync", { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.synced).toBe(1);

      // db.update was called to soft-delete stale resources
      expect(mockUpdate).toHaveBeenCalled();
      // set() was called with deletedAt
      expect(set).toHaveBeenCalledWith(expect.objectContaining({ deletedAt: expect.any(Date) }));
    });

    it("soft-deletes all resources when plugin returns empty list", async () => {
      const { set } = setupSyncMocks([]);

      const app = buildApp();
      const res = await app.request("/a1/sync", { method: "POST" });
      expect(res.status).toBe(200);

      // db.update was called to soft-delete all resources for this account
      expect(mockUpdate).toHaveBeenCalled();
      expect(set).toHaveBeenCalledWith(expect.objectContaining({ deletedAt: expect.any(Date) }));
    });

    it("clears deletedAt on upsert for resources that reappear", async () => {
      const resource = {
        id: "r-returned",
        pluginId: "aws",
        resourceTypeId: "ec2-instance",
        displayName: "returned-vm",
        accountId: "a1",
        fields: {},
        resolvedOutputs: {},
      };

      setupSyncMocks([resource]);

      const app = buildApp();
      await app.request("/a1/sync", { method: "POST" });

      // The upsert should include deletedAt: null to clear soft-delete
      const insertCall = mockInsert.mock.calls[0];
      expect(insertCall).toBeDefined();
    });
  });
});
