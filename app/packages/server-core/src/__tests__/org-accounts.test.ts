import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
vi.mock("../db/client", () => ({ db: { select: (...a: unknown[]) => mockSelect(...a) } }));

vi.mock("../encryption", () => ({
  decrypt: vi.fn().mockResolvedValue(JSON.stringify({ token: "secret" })),
  buildAad: vi.fn().mockReturnValue("aad"),
}));

const mockGetPlugin = vi.fn();
vi.mock("../plugin-loader", () => ({ getPlugin: (...a: unknown[]) => mockGetPlugin(...a) }));

vi.mock("../host-services", () => ({
  buildPluginHostServices: vi.fn().mockResolvedValue({}),
}));

const mockApplyRewriters = vi.fn();
vi.mock("../credential-rewriters", () => ({
  applyCredentialRewriters: (...a: unknown[]) => mockApplyRewriters(...a),
}));

const { getOrgAccountClient } = await import("../org-accounts");

describe("getOrgAccountClient", () => {
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
    expect(await getOrgAccountClient("a1", "org-1")).toBeNull();
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
    expect(await getOrgAccountClient("a1", "org-1")).toBeNull();
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

    const result = await getOrgAccountClient("a1", "org-1");
    expect(result).not.toBeNull();
    expect(result!.client).toEqual({ kind: "client" });
    expect(createClient).toHaveBeenCalledWith({ token: "secret" }, {});
    expect(mockApplyRewriters).toHaveBeenCalled();
  });
});
