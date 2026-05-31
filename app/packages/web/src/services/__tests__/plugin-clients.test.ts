import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
vi.mock("@/db/client", () => ({ db: { select: (...a: unknown[]) => mockSelect(...a) } }));

vi.mock("@/services/encryption", () => ({
  decrypt: vi.fn().mockResolvedValue(JSON.stringify({ token: "secret" })),
  buildAad: vi.fn().mockReturnValue("aad"),
}));

const mockGetPlugin = vi.fn();
vi.mock("@/plugins/loader", () => ({ getPlugin: (...a: unknown[]) => mockGetPlugin(...a) }));

vi.mock("@/services/host-services", () => ({
  buildPluginHostServices: vi.fn().mockResolvedValue({}),
}));

const mockApplyRewriters = vi.fn();
vi.mock("@/services/credential-rewriters", () => ({
  applyCredentialRewriters: (...a: unknown[]) => mockApplyRewriters(...a),
}));

const { filterVisiblePeerIntegrations, getClientForAccount } =
  await import("@/services/plugin-clients");

describe("filterVisiblePeerIntegrations", () => {
  it("keeps integrations with no gates", () => {
    const out = filterVisiblePeerIntegrations([{ pluginId: "x" } as never], {});
    expect(out).toHaveLength(1);
  });

  it("drops integrations whose requiresFields are unset", () => {
    const out = filterVisiblePeerIntegrations(
      [{ pluginId: "x", requiresFields: ["connectionName"] } as never],
      { connectionName: "" },
    );
    expect(out).toHaveLength(0);
  });

  it("keeps integrations whose requiresFields are present", () => {
    const out = filterVisiblePeerIntegrations(
      [{ pluginId: "x", requiresFields: ["connectionName"] } as never],
      { connectionName: "proj:region:inst" },
    );
    expect(out).toHaveLength(1);
  });

  it("applies showWhen equals matching", () => {
    const integration = { pluginId: "x", showWhen: { fieldKey: "engine", equals: "postgres" } };
    expect(
      filterVisiblePeerIntegrations([integration as never], { engine: "postgres" }),
    ).toHaveLength(1);
    expect(filterVisiblePeerIntegrations([integration as never], { engine: "mysql" })).toHaveLength(
      0,
    );
  });

  it("applies showWhen prefix matching", () => {
    const integration = { pluginId: "x", showWhen: { fieldKey: "engine", prefix: "POSTGRES" } };
    expect(
      filterVisiblePeerIntegrations([integration as never], { engine: "POSTGRES_14" }),
    ).toHaveLength(1);
    expect(
      filterVisiblePeerIntegrations([integration as never], { engine: "MYSQL_8" }),
    ).toHaveLength(0);
  });
});

describe("getClientForAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApplyRewriters.mockResolvedValue(undefined);
  });

  function selectAccount(rows: unknown[]) {
    const limit = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    mockSelect.mockReturnValue({ from });
  }

  it("returns null when the account does not exist", async () => {
    selectAccount([]);
    expect(await getClientForAccount("a1", "org-1")).toBeNull();
  });

  it("returns null when the plugin is not registered", async () => {
    selectAccount([
      {
        id: "a1",
        pluginId: "ghost",
        encryptedCredentials: "e",
        credentialsIv: "iv",
        bastionId: null,
      },
    ]);
    mockGetPlugin.mockResolvedValue(null);
    expect(await getClientForAccount("a1", "org-1")).toBeNull();
  });

  it("decrypts credentials and instantiates the plugin client", async () => {
    selectAccount([
      {
        id: "a1",
        pluginId: "aws",
        encryptedCredentials: "e",
        credentialsIv: "iv",
        bastionId: null,
      },
    ]);
    const createClient = vi.fn().mockReturnValue({ kind: "client" });
    mockGetPlugin.mockResolvedValue({
      plugin: { manifest: { id: "aws" }, createClient },
    });

    const result = await getClientForAccount("a1", "org-1");
    expect(result).not.toBeNull();
    expect(result!.client).toEqual({ kind: "client" });
    expect(createClient).toHaveBeenCalledWith({ token: "secret" }, {});
    expect(mockApplyRewriters).toHaveBeenCalled();
  });
});
