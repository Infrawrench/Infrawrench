import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

const mockInsert = vi.fn();
const mockSelect = vi.fn();
const mockSelectDistinct = vi.fn();
const mockDelete = vi.fn();
const mockUpdate = vi.fn();
const mockTransaction = vi.fn();

const dbMock = {
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
    select: (...args: unknown[]) => mockSelect(...args),
    selectDistinct: (...args: unknown[]) => mockSelectDistinct(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    transaction: (...args: unknown[]) => mockTransaction(...args),
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

const mockRefreshAllowlist = vi.hoisted(() => vi.fn(async (_bastionId: string) => undefined));
vi.mock("@infrawrench/server-core/bastion/registry", () => ({
  refreshAllowlistById: mockRefreshAllowlist,
}));

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

const { accountsDomain } = await import("@/http/domains/accounts/index");
const { planAccess } = await import("@/services/entitlements");
const { pluginCatalogUrl } = await import("@/lib/plugin-catalog");

const basePath = "/api/org/org-1/accounts";
const buildApp = () => buildTestApi(accountsDomain, { basePath });

/**
 * Served at the API's own paths, so tests can request the exact URLs the web
 * client builds. The Update Credentials flow shipped asking for
 * `/api/org/:orgId/plugins` (a path no router serves) and 404'd every time.
 */
const buildMountedApp = () => buildTestApi(accountsDomain);

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

  describe("GET /plugins: list available plugins", () => {
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

    it("carries what the host needs from each plugin's manifest", async () => {
      const sshTunnel = {
        label: "Thing",
        defaultPort: 1234,
        credentials: { connectionString: "thing://localhost:{port}" },
      };
      mockLoadPlugins.mockResolvedValue([
        {
          plugin: {
            manifest: {
              id: "tunneled",
              displayName: "Tunneled",
              logoSvg: "<svg/>",
              credentialFields: [],
              sshTunnel,
              jumpHost: true,
              kvDriver: { driver: "wire", credentialKey: "uri", browser: "documents" },
            },
          },
        },
        {
          plugin: {
            manifest: { id: "bare", displayName: "Bare", logoSvg: "<svg/>", credentialFields: [] },
          },
        },
      ]);

      const res = await buildApp().request("/plugins", { method: "GET" });
      const [tunneled, bare] = await res.json();
      expect(tunneled).toMatchObject({ sshTunnel, jumpHost: true, kvBrowser: "documents" });
      expect(bare).not.toHaveProperty("sshTunnel");
      expect(bare).not.toHaveProperty("jumpHost");
      expect(bare).not.toHaveProperty("kvBrowser");
    });

    it("serves the URL the web client asks for", async () => {
      mockLoadPlugins.mockResolvedValue([]);

      const res = await buildMountedApp().request(pluginCatalogUrl("org-1"));

      expect(res.status).toBe(200);
    });
  });

  describe("GET /: list accounts", () => {
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

    it("is served without a trailing slash, as the clients ask for it", async () => {
      const where = vi.fn().mockResolvedValue([]);
      mockSelect.mockReturnValue({ from: vi.fn().mockReturnValue({ where }) });

      const res = await buildMountedApp().request("/api/org/org-1/accounts");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });
  });

  describe("POST /: create an account", () => {
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

  describe("the apps a connection is for (products)", () => {
    const capability = (id: string) => ({ id, label: id, requiredPermissions: [] });
    /** Offers Infrastructure, Costs and Observability. */
    const cloudPlugin = {
      plugin: {
        manifest: {
          id: "aws",
          credentialFields: [],
          preflight: {
            capabilities: [capability("resources"), capability("costs"), capability("metrics")],
          },
        },
      },
    };

    // Later suites rely on no plugin being found unless they set one.
    afterEach(() => {
      mockGetPlugin.mockReset();
      mockSelect.mockReset();
      mockUpdate.mockReset();
      mockInsert.mockReset();
    });

    const create = (products: unknown) =>
      buildApp().request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pluginId: "aws",
          displayName: "Billing",
          credentials: { accessKeyId: "id", secretAccessKey: "secret" },
          products,
        }),
      });

    function setupCreate() {
      const values = vi.fn().mockResolvedValue(undefined);
      mockInsert.mockReturnValue({ values });
      mockSelect.mockReturnValue(chainMock([]));
      mockGetPlugin.mockResolvedValue(cloudPlugin);
      return values;
    }

    it("stores a subset in the canonical order", async () => {
      const values = setupCreate();

      const res = await create(["observability", "costs"]);

      expect(res.status).toBe(200);
      expect(values.mock.calls[0]![0].products).toEqual(["costs", "observability"]);
    });

    it("stores null when nothing is chosen, as every account before the choice has", async () => {
      const values = setupCreate();

      expect((await create(undefined)).status).toBe(200);
      expect(values.mock.calls[0]![0].products).toBeNull();
    });

    it("stores null when the choice is everything the plugin offers", async () => {
      const values = setupCreate();

      expect((await create(["costs", "infrastructure", "observability"])).status).toBe(200);
      expect(values.mock.calls[0]![0].products).toBeNull();
    });

    it("does not sync resources for a connection made for Costs alone", async () => {
      const values = setupCreate();

      const res = await create(["costs"]);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: "acct-uuid-1" });
      expect(values.mock.calls[0]![0].products).toEqual(["costs"]);
      // The sync's first step is reading the account row; it never ran.
      expect(mockSelect).not.toHaveBeenCalled();
    });

    it.each([
      ["an empty list", []],
      ["an unknown id", ["costs", "billing"]],
      ["an app the plugin does not offer", ["security"]],
      ["something that is not a list", "costs"],
    ])("400s for %s and stores nothing", async (_name, products) => {
      const values = setupCreate();

      const res = await create(products);

      expect(res.status).toBe(400);
      expect(values).not.toHaveBeenCalled();
    });

    it("400s for any list when the plugin has no preflight", async () => {
      const values = setupCreate();
      mockGetPlugin.mockResolvedValue({
        plugin: { manifest: { id: "aws", credentialFields: [] } },
      });

      expect((await create(["costs"])).status).toBe(400);
      expect(values).not.toHaveBeenCalled();
    });

    describe("PATCH /:id", () => {
      const patch = (body: unknown) =>
        buildApp().request("/a1", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      function setupUpdate() {
        mockGetPlugin.mockResolvedValue(cloudPlugin);
        mockSelect.mockReturnValue(chainMock([{ pluginId: "aws", bastionId: null }]));
        const returning = vi.fn(async () => [
          { id: "a1", displayName: "Billing", bastionId: null, products: ["costs"] },
        ]);
        const set = vi.fn((_values: Record<string, unknown>) => ({
          where: vi.fn(() => ({ returning })),
        }));
        mockUpdate.mockReturnValue({ set });
        return set;
      }

      it("changes the apps and makes collection due now", async () => {
        const set = setupUpdate();

        const res = await patch({ products: ["costs"] });

        expect(res.status).toBe(200);
        expect((await res.json()).products).toEqual(["costs"]);
        const written = set.mock.calls[0]![0];
        expect(written["products"]).toEqual(["costs"]);
        expect(written["nextPollAt"]).toBeInstanceOf(Date);
        expect(written["costNextPollAt"]).toBeInstanceOf(Date);
      });

      it("writes null for every app", async () => {
        const set = setupUpdate();

        expect((await patch({ products: null })).status).toBe(200);
        expect(set.mock.calls[0]![0]).toHaveProperty("products", null);
      });

      it("leaves the apps alone when the field is absent", async () => {
        const set = setupUpdate();

        expect((await patch({ displayName: "Renamed" })).status).toBe(200);
        expect(set.mock.calls[0]![0]).toEqual({ displayName: "Renamed" });
      });

      it("400s for an app the plugin does not offer, without writing", async () => {
        const set = setupUpdate();

        expect((await patch({ products: ["delivery"] })).status).toBe(400);
        expect(set).not.toHaveBeenCalled();
      });

      it("400s for an empty list", async () => {
        const set = setupUpdate();

        expect((await patch({ products: [] })).status).toBe(400);
        expect(set).not.toHaveBeenCalled();
      });

      it("404s when the account is not in the org", async () => {
        setupUpdate();
        mockSelect.mockReturnValue(chainMock([]));

        expect((await patch({ products: ["costs"] })).status).toBe(404);
      });
    });

    it("refuses a manual sync of a costs-only account with a readable 400", async () => {
      const where = vi.fn().mockResolvedValue([{ products: ["costs"] }]);
      mockSelect.mockReturnValue({ from: vi.fn().mockReturnValue({ where }) });

      const res = await buildApp().request("/a1/sync", { method: "POST" });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("Costs only");
      // Only the gate read the account; the sync did not start.
      expect(mockSelect).toHaveBeenCalledTimes(1);
      expect(mockGetPlugin).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /:id: delete an account", () => {
    it("deletes the account and returns ok", async () => {
      const returning = vi.fn().mockResolvedValue([{ bastionId: null }]);
      mockDelete.mockReturnValue({ where: vi.fn(() => ({ returning })) });

      const app = buildApp();
      const res = await app.request("/a1", { method: "DELETE" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(mockRefreshAllowlist).not.toHaveBeenCalled();
    });

    it("takes a bastion-bound account's hosts off the bastion's allowlist", async () => {
      const returning = vi.fn().mockResolvedValue([{ bastionId: "b1" }]);
      mockDelete.mockReturnValue({ where: vi.fn(() => ({ returning })) });

      const res = await buildApp().request("/a1", { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(mockRefreshAllowlist).toHaveBeenCalledWith("b1");
    });
  });

  describe("GET /:id/credentials: read decrypted credentials", () => {
    it("returns the plaintext and writes an audit entry", async () => {
      const where = vi
        .fn()
        .mockResolvedValue([{ encryptedCredentials: "enc", credentialsIv: "iv" }]);
      mockSelect.mockReturnValue({ from: vi.fn().mockReturnValue({ where }) });

      const res = await buildApp().request("/a1/credentials");

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

      const res = await buildApp().request("/nope/credentials");

      expect(res.status).toBe(404);
      expect(mockLogAudit).not.toHaveBeenCalled();
    });
  });

  describe("provider OAuth credentials", () => {
    const oauthManifest = {
      id: "acme",
      displayName: "Acme",
      credentialFields: [],
      oauth: {
        authorizeUrl: "https://acme.example/authorize",
        tokenUrl: "https://acme.example/token",
        scopes: [],
        tokenField: "token",
        clients: { server: {} },
        access: "read-only",
        refresh: "rotating",
      },
    };
    const grantJson = (expiresAt: number) =>
      JSON.stringify({
        v: 1,
        client: "server",
        refreshToken: "rt-secret",
        expiresAt,
        connectedAt: 1,
      });

    function selectRow(row: Record<string, unknown>) {
      const where = vi.fn().mockResolvedValue([row]);
      mockSelect.mockReturnValue({ from: vi.fn().mockReturnValue({ where }) });
    }

    it("GET /:id/credentials returns the grant redacted, never the refresh token", async () => {
      mockGetPlugin.mockResolvedValue({ plugin: { manifest: oauthManifest } });
      encryptionMock.decrypt.mockResolvedValueOnce(
        JSON.stringify({ token: "at", __oauth: grantJson(Date.now() + 3_600_000) }),
      );
      selectRow({ id: "a1", pluginId: "acme", oauthStatus: "connected" });

      const res = await buildApp().request("/a1/credentials");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.token).toBe("at");
      expect(body.__oauth).not.toContain("rt-secret");
      expect(JSON.parse(body.__oauth)).toMatchObject({ v: 1, client: "server" });
    });

    it("GET /:id/credentials does not refresh or fail a reconnect_required account", async () => {
      mockGetPlugin.mockResolvedValue({ plugin: { manifest: oauthManifest } });
      encryptionMock.decrypt.mockResolvedValueOnce(
        JSON.stringify({ token: "at-dead", __oauth: grantJson(Date.now() - 1000) }),
      );
      selectRow({ id: "a1", pluginId: "acme", oauthStatus: "reconnect_required" });
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const res = await buildApp().request("/a1/credentials");
      expect(res.status).toBe(200);
      expect((await res.json()).token).toBe("at-dead");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockTransaction).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    function lockedRow(stored: Record<string, string>) {
      encryptionMock.decrypt.mockResolvedValueOnce(JSON.stringify(stored));
      const txUpdateWhere = vi.fn().mockResolvedValue(undefined);
      const txSet = vi.fn().mockReturnValue({ where: txUpdateWhere });
      const tx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              for: vi.fn().mockResolvedValue([{ encryptedCredentials: "e", credentialsIv: "i" }]),
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({ set: txSet }),
      };
      mockTransaction.mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx));
      mockUpdate.mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      });
      return { txSet };
    }

    it("PUT /:id/credentials refreshes the bastion's allowlist, for a host that moved", async () => {
      mockGetPlugin.mockResolvedValue({ plugin: { manifest: oauthManifest } });
      mockSelect.mockReturnValue(
        chainMock([{ id: "a1", pluginId: "acme", oauthStatus: null, bastionId: "b1" }]),
      );
      lockedRow({ token: "at" });

      const res = await buildApp().request("/a1/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentials: { token: "at", url: "https://moved.acme.example" } }),
      });
      expect(res.status).toBe(200);
      expect(mockRefreshAllowlist).toHaveBeenCalledWith("b1");
    });

    it("PUT /:id/credentials keeps the stored grant when only a picker changed", async () => {
      mockGetPlugin.mockResolvedValue({ plugin: { manifest: oauthManifest } });
      mockSelect.mockReturnValue(
        chainMock([{ id: "a1", pluginId: "acme", oauthStatus: "connected" }]),
      );
      const stored = { token: "at", region: "eu", __oauth: grantJson(Date.now() + 3_600_000) };
      const { txSet } = lockedRow(stored);

      const res = await buildApp().request("/a1/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // What the edit form sends back: the redacted grant from GET.
        body: JSON.stringify({
          credentials: {
            token: "at",
            region: "us",
            __oauth: JSON.stringify({ v: 1, client: "server", connectedAt: 1 }),
          },
        }),
      });
      expect(res.status).toBe(200);
      const written = JSON.parse(encryptionMock.encrypt.mock.calls.at(-1)![0] as string);
      expect(written).toEqual({ token: "at", region: "us", __oauth: stored.__oauth });
      expect(txSet).toHaveBeenCalledWith(expect.objectContaining({ oauthStatus: "connected" }));
    });

    it("PUT /:id/credentials drops the grant for a newly pasted token", async () => {
      mockGetPlugin.mockResolvedValue({ plugin: { manifest: oauthManifest } });
      mockSelect.mockReturnValue(
        chainMock([{ id: "a1", pluginId: "acme", oauthStatus: "connected" }]),
      );
      const { txSet } = lockedRow({ token: "at", __oauth: grantJson(Date.now() + 3_600_000) });

      const res = await buildApp().request("/a1/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentials: { token: "pasted" } }),
      });
      expect(res.status).toBe(200);
      const written = JSON.parse(encryptionMock.encrypt.mock.calls.at(-1)![0] as string);
      expect(written).toEqual({ token: "pasted" });
      expect(txSet).toHaveBeenCalledWith(expect.objectContaining({ oauthStatus: null }));
    });

    it("POST / rejects a forged __oauth value", async () => {
      mockGetPlugin.mockResolvedValue({ plugin: { manifest: oauthManifest } });
      const res = await buildApp().request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pluginId: "acme",
          displayName: "Acme",
          credentials: { token: "x", __oauth: grantJson(Date.now() + 3_600_000) },
        }),
      });
      expect(res.status).toBe(400);
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });

  describe("POST /:id/sync: trigger resource sync", () => {
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

    it("says which lists could not be read whole, and leaves it out otherwise", async () => {
      const { mockClient, updateWhere } = setupSyncMocks([]);
      const app = buildApp();
      expect(await (await app.request("/a1/sync", { method: "POST" })).json()).toEqual({
        synced: 0,
      });

      updateWhere.mockClear();
      mockClient.listResources.mockRejectedValue(
        Object.assign(new Error("Vendor: /x has more than Infrawrench reads."), {
          incompleteList: true,
        }),
      );
      const res = await app.request("/a1/sync", { method: "POST" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        synced: 0,
        incompleteLists: [
          {
            resourceTypeId: "ec2-instance",
            message: "Vendor: /x has more than Infrawrench reads.",
          },
        ],
      });
      expect(updateWhere).not.toHaveBeenCalled();
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

  describe("POST /preflight: ad-hoc credential probe", () => {
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

  describe("POST /credential-options: provider-filled credential pickers", () => {
    const optionsManifest = {
      id: "newrelic",
      displayName: "New Relic",
      logoSvg: "<svg/>",
      credentialFields: [
        { key: "apiKey", label: "Key", sensitive: true },
        {
          key: "accountId",
          label: "Account",
          sensitive: false,
          providerOptions: { dependsOn: ["apiKey"] },
        },
      ],
    };
    const post = (body: unknown) =>
      buildApp().request("/credential-options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    it("returns the plugin's options for the submitted credentials", async () => {
      const listCredentialOptions = vi
        .fn()
        .mockResolvedValue([{ id: "42", label: "Parent", description: "42" }]);
      mockGetPlugin.mockResolvedValue({
        plugin: { manifest: optionsManifest, createClient: vi.fn(), listCredentialOptions },
      });
      const res = await post({
        pluginId: "newrelic",
        fieldKey: "accountId",
        credentials: { apiKey: "NRAK-X" },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).options).toEqual([
        { id: "42", label: "Parent", description: "42" },
      ]);
      expect(listCredentialOptions).toHaveBeenCalledWith(
        "accountId",
        { apiKey: "NRAK-X" },
        expect.anything(),
      );
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("400s with the plugin's message when listing fails", async () => {
      mockGetPlugin.mockResolvedValue({
        plugin: {
          manifest: optionsManifest,
          createClient: vi.fn(),
          listCredentialOptions: vi.fn().mockRejectedValue(new Error("New Relic rejected the key")),
        },
      });
      const res = await post({ pluginId: "newrelic", fieldKey: "accountId", credentials: {} });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("rejected the key");
    });

    it("400s for a field without provider options", async () => {
      mockGetPlugin.mockResolvedValue({
        plugin: {
          manifest: optionsManifest,
          createClient: vi.fn(),
          listCredentialOptions: vi.fn(),
        },
      });
      const res = await post({ pluginId: "newrelic", fieldKey: "apiKey", credentials: {} });
      expect(res.status).toBe(400);
    });
  });

  describe("server credential policy", () => {
    // A plugin that refuses some credentials on the shared server (the
    // kubernetes plugin refuses kubeconfigs with exec plugins this way).
    const validateServerCredentials = vi.fn((creds: Record<string, string>) =>
      creds["kubeconfig"]?.includes("exec") ? "This kubeconfig can't be used in cloud" : null,
    );
    const createClient = vi.fn();
    const unsafe = { kubeconfig: "users: [{ name: u, user: { exec: { command: sh } } }]" };

    beforeEach(() => {
      mockGetPlugin.mockResolvedValue({
        plugin: { manifest: preflightManifest, createClient, validateServerCredentials },
      });
    });

    it("POST / refuses the credentials before storing anything", async () => {
      const res = await buildApp().request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pluginId: "kubernetes", displayName: "k", credentials: unsafe }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("can't be used in cloud");
      expect(mockInsert).not.toHaveBeenCalled();
      expect(encryptionMock.encrypt).not.toHaveBeenCalled();
    });

    it("POST /preflight refuses before building a client", async () => {
      const res = await buildApp().request("/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pluginId: "kubernetes", credentials: unsafe }),
      });
      expect(res.status).toBe(400);
      expect(createClient).not.toHaveBeenCalled();
      expect(hostServicesMock.buildPluginHostServices).not.toHaveBeenCalled();
    });

    it("PUT /:id/credentials refuses before overwriting the stored blob", async () => {
      mockSelect.mockReturnValue(chainMock([{ id: "a1", pluginId: "kubernetes" }]));
      const res = await buildApp().request("/a1/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentials: unsafe }),
      });
      expect(res.status).toBe(400);
      expect(validateServerCredentials).toHaveBeenCalledWith(unsafe);
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  describe("POST /:accountId/preflight: stored-account probe", () => {
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

  describe("GET /plugins/:pluginId/policy-template: least-privilege template", () => {
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
