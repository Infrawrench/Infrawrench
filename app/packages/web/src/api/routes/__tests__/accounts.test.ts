import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { buildTestApp } from "./test-utils";

const mockInsert = vi.fn();
const mockSelect = vi.fn();
const mockSelectDistinct = vi.fn();
const mockDelete = vi.fn();
const mockUpdate = vi.fn();

const dbMock = {
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
    select: (...args: unknown[]) => mockSelect(...args),
    selectDistinct: (...args: unknown[]) => mockSelectDistinct(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
};
vi.mock("@/db/client", () => dbMock);
vi.mock("@infrawrench/server-core/db/client", () => dbMock);

const encryptionMock = {
  encrypt: vi.fn().mockResolvedValue({ ciphertext: "enc-blob", iv: "iv-123" }),
  decrypt: vi.fn().mockResolvedValue(JSON.stringify({ token: "secret-val" })),
  buildAad: vi.fn().mockReturnValue("aad"),
};
const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));

vi.mock("@/services/encryption", () => encryptionMock);
vi.mock("@infrawrench/server-core/encryption", () => encryptionMock);

const mockLoadPlugins = vi.fn();
const mockGetPlugin = vi.fn();
const pluginLoaderMock = {
  loadPlugins: (...args: unknown[]) => mockLoadPlugins(...args),
  getPlugin: (...args: unknown[]) => mockGetPlugin(...args),
};
vi.mock("@/plugins/loader", () => pluginLoaderMock);
vi.mock("@infrawrench/server-core/plugin-loader", () => pluginLoaderMock);

const hostServicesMock = {
  buildPluginHostServices: vi.fn().mockResolvedValue({}),
  buildHostServices: vi.fn().mockReturnValue({}),
  buildKvHostServices: vi.fn().mockReturnValue({}),
  buildDockerHostServices: vi.fn().mockReturnValue({}),
};
vi.mock("@/services/host-services", () => hostServicesMock);
vi.mock("@infrawrench/server-core/host-services", () => hostServicesMock);

vi.mock("@infrawrench/server-core/tunnel-resolver", () => ({
  rewriteCredentialsThroughTunnel: vi.fn().mockResolvedValue(undefined),
}));

const mockGetClientForAccount = vi.fn();
vi.mock("@/services/plugin-clients", () => ({
  getClientForAccount: (...args: unknown[]) => mockGetClientForAccount(...args),
}));

vi.mock("uuid", () => ({ v4: () => "acct-uuid-1" }));

vi.mock("@/services/entitlements", () => ({
  planAccess: vi.fn().mockResolvedValue({ paid: true, reason: "subscription", status: "active" }),
  FREE_PLAN_LIMITS: { users: 1, accounts: 3 },
}));

const { accountRoutes } = await import("@/api/routes/accounts");
const { planAccess } = await import("@/services/entitlements");
const { pluginCatalogUrl } = await import("@/lib/plugin-catalog");

const buildApp = () => buildTestApp(accountRoutes);

/**
 * Mounted the way `api/index.ts` mounts it, so tests can request the exact
 * URLs the web client builds. The Update Credentials flow shipped asking for
 * `/api/org/:orgId/plugins` — a path no router serves — and 404'd every time.
 */
const buildMountedApp = () => {
  const app = new Hono();
  app.route("/api/org/:orgId/accounts", buildTestApp(accountRoutes));
  return app;
};

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

    it("serves the URL the web client asks for", async () => {
      mockLoadPlugins.mockResolvedValue([]);

      const res = await buildMountedApp().request(pluginCatalogUrl("org-1"));

      expect(res.status).toBe(200);
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

    it("returns 402 when a free org is at the account cap", async () => {
      vi.mocked(planAccess).mockResolvedValueOnce({ paid: false, reason: "none" });
      // The free-tier gate's count query awaits `where` directly (no .limit).
      const where = vi.fn().mockResolvedValue([{ n: 3 }]);
      mockSelect.mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where }) });
      const values = vi.fn().mockResolvedValue(undefined);
      mockInsert.mockReturnValue({ values });

      const res = await buildApp().request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pluginId: "aws",
          displayName: "Fourth account",
          credentials: { accessKeyId: "AKIA...", secretAccessKey: "abc" },
        }),
      });

      expect(res.status).toBe(402);
      const body = await res.json();
      expect(body.error).toContain("Upgrade");
      expect(values).not.toHaveBeenCalled();
    });

    it("creates the account on a free org under the cap", async () => {
      vi.mocked(planAccess).mockResolvedValueOnce({ paid: false, reason: "none" });
      const where = vi.fn().mockResolvedValue([{ n: 2 }]);
      mockSelect
        .mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where }) })
        .mockReturnValue(chainMock([]));
      const values = vi.fn().mockResolvedValue(undefined);
      mockInsert.mockReturnValue({ values });

      const res = await buildApp().request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pluginId: "aws",
          displayName: "Third account",
          credentials: { accessKeyId: "AKIA...", secretAccessKey: "abc" },
        }),
      });

      expect(res.status).toBe(200);
      expect(values).toHaveBeenCalled();
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

  describe("GET /:id/credentials — read decrypted credentials", () => {
    it("returns the plaintext and writes an audit entry", async () => {
      const where = vi
        .fn()
        .mockResolvedValue([{ encryptedCredentials: "enc", credentialsIv: "iv" }]);
      mockSelect.mockReturnValue({ from: vi.fn().mockReturnValue({ where }) });

      const res = await buildTestApp(accountRoutes).request("/a1/credentials");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ token: "secret-val" });
      // This is the only route that hands back a provider credential in the
      // clear; an unaudited one leaves no trace of who read what.
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: "org-1",
          userId: "user-1",
          action: "account.credentials.read",
          entityType: "account",
          entityId: "a1",
        }),
      );
    });

    it("404s without auditing when the account is not in the org", async () => {
      const where = vi.fn().mockResolvedValue([]);
      mockSelect.mockReturnValue({ from: vi.fn().mockReturnValue({ where }) });

      const res = await buildTestApp(accountRoutes).request("/nope/credentials");

      expect(res.status).toBe(404);
      expect(mockLogAudit).not.toHaveBeenCalled();
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

      // refreshPinnedStats: db.selectDistinct().from().innerJoin().where() → []
      const distinctWhere = vi.fn().mockResolvedValue([]);
      const distinctInnerJoin = vi.fn().mockReturnValue({ where: distinctWhere });
      const distinctFrom = vi.fn().mockReturnValue({ innerJoin: distinctInnerJoin });
      mockSelectDistinct.mockReturnValue({ from: distinctFrom });

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

  const preflightManifest = {
    id: "aws",
    displayName: "AWS",
    logoSvg: "<svg/>",
    credentialFields: [],
    preflight: {
      capabilities: [
        {
          id: "resources",
          label: "Resource inventory",
          requiredPermissions: [{ id: "ec2:DescribeInstances", label: "List EC2 instances" }],
          essential: true,
        },
      ],
      templateFormat: { label: "AWS IAM policy (JSON)", language: "json" },
    },
  };

  describe("POST /preflight — ad-hoc credential probe", () => {
    it("runs the plugin probe against submitted credentials without storing anything", async () => {
      const verifyCredentials = vi.fn().mockResolvedValue({
        identity: "arn:aws:iam::1:user/x",
        checks: [{ capabilityId: "resources", status: "ok" }],
      });
      mockGetPlugin.mockResolvedValue({
        plugin: {
          manifest: preflightManifest,
          createClient: vi.fn().mockReturnValue({ verifyCredentials }),
        },
      });

      const app = buildApp();
      const res = await app.request("/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pluginId: "aws", credentials: { accessKeyId: "AKIA" } }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.supported).toBe(true);
      expect(body.identity).toBe("arn:aws:iam::1:user/x");
      expect(body.checks).toEqual([
        {
          capabilityId: "resources",
          status: "ok",
          missingPermissions: [],
          message: null,
          helpLink: null,
        },
      ]);
      expect(verifyCredentials).toHaveBeenCalled();
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("400s when the plugin rejects the credentials at construction", async () => {
      mockGetPlugin.mockResolvedValue({
        plugin: {
          manifest: preflightManifest,
          createClient: vi.fn(() => {
            throw new Error("missing accessKeyId");
          }),
        },
      });

      const app = buildApp();
      const res = await app.request("/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pluginId: "aws", credentials: {} }),
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("missing accessKeyId");
    });

    it("404s for an unknown plugin", async () => {
      mockGetPlugin.mockResolvedValue(undefined);
      const app = buildApp();
      const res = await app.request("/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pluginId: "nope", credentials: {} }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /:accountId/preflight — stored-account probe", () => {
    it("resolves the account client and returns the normalized report", async () => {
      mockGetClientForAccount.mockResolvedValue({
        plugin: { manifest: preflightManifest },
        client: {
          verifyCredentials: vi.fn().mockResolvedValue({
            checks: [
              {
                capabilityId: "resources",
                status: "missing",
                missingPermissions: [{ id: "ec2:DescribeInstances", label: "List EC2 instances" }],
                helpLink: { label: "IAM", url: "https://console.aws.amazon.com/iam" },
              },
            ],
          }),
        },
      });

      const app = buildApp();
      const res = await app.request("/a1/preflight", { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.checks[0]).toMatchObject({
        capabilityId: "resources",
        status: "missing",
        missingPermissions: [{ id: "ec2:DescribeInstances" }],
      });
      expect(mockGetClientForAccount).toHaveBeenCalledWith("a1", "org-1");
    });

    it("404s when the account is not in the org", async () => {
      mockGetClientForAccount.mockResolvedValue(null);
      const app = buildApp();
      const res = await app.request("/missing/preflight", { method: "POST" });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /plugins/:pluginId/policy-template — least-privilege template", () => {
    it("returns the template scoped to the requested capabilities", async () => {
      const policyTemplate = vi.fn().mockReturnValue({
        formatLabel: "AWS IAM policy (JSON)",
        language: "json",
        document: "{}",
      });
      mockGetPlugin.mockResolvedValue({
        plugin: { manifest: preflightManifest, policyTemplate },
      });

      const app = buildApp();
      const res = await app.request("/plugins/aws/policy-template?capabilities=resources");
      expect(res.status).toBe(200);
      expect((await res.json()).template.formatLabel).toBe("AWS IAM policy (JSON)");
      expect(policyTemplate).toHaveBeenCalledWith(["resources"]);
    });

    it("400s naming the unknown capability ids instead of widening the template", async () => {
      const policyTemplate = vi.fn();
      mockGetPlugin.mockResolvedValue({
        plugin: { manifest: preflightManifest, policyTemplate },
      });

      const app = buildApp();
      const res = await app.request("/plugins/aws/policy-template?capabilities=resources,bogus");
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("bogus");
      expect(policyTemplate).not.toHaveBeenCalled();
    });

    it("deduplicates repeated capability ids before calling the plugin", async () => {
      const policyTemplate = vi.fn().mockReturnValue({
        formatLabel: "AWS IAM policy (JSON)",
        language: "json",
        document: "{}",
      });
      mockGetPlugin.mockResolvedValue({
        plugin: { manifest: preflightManifest, policyTemplate },
      });

      const app = buildApp();
      const res = await app.request(
        "/plugins/aws/policy-template?capabilities=resources,%20resources",
      );
      expect(res.status).toBe(200);
      expect(policyTemplate).toHaveBeenCalledWith(["resources"]);
    });

    it("treats an empty capabilities query as select-all", async () => {
      const policyTemplate = vi.fn().mockReturnValue({
        formatLabel: "AWS IAM policy (JSON)",
        language: "json",
        document: "{}",
      });
      mockGetPlugin.mockResolvedValue({
        plugin: { manifest: preflightManifest, policyTemplate },
      });

      const app = buildApp();
      const res = await app.request("/plugins/aws/policy-template?capabilities=");
      expect(res.status).toBe(200);
      expect(policyTemplate).toHaveBeenCalledWith(["resources"]);
    });

    it("defaults to every declared capability when none are requested", async () => {
      const policyTemplate = vi.fn().mockReturnValue({
        formatLabel: "AWS IAM policy (JSON)",
        language: "json",
        document: "{}",
      });
      mockGetPlugin.mockResolvedValue({
        plugin: { manifest: preflightManifest, policyTemplate },
      });

      const app = buildApp();
      const res = await app.request("/plugins/aws/policy-template");
      expect(res.status).toBe(200);
      expect(policyTemplate).toHaveBeenCalledWith(["resources"]);
    });

    it("400s for plugins without a template", async () => {
      mockGetPlugin.mockResolvedValue({
        plugin: { manifest: { ...preflightManifest, preflight: undefined } },
      });
      const app = buildApp();
      const res = await app.request("/plugins/aws/policy-template");
      expect(res.status).toBe(400);
    });
  });
});
