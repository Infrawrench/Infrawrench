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

const { resolveKubeconfig } = await import("@/services/k8s-kubeconfig-resolver");

const ACCOUNT = {
  id: "a1",
  pluginId: "google-cloud",
  encryptedCredentials: "e",
  credentialsIv: "iv",
};

function chainResolving(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  return { from };
}

describe("resolveKubeconfig", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null when the account is missing", async () => {
    mockSelect.mockReturnValue(chainResolving([]));
    expect(await resolveKubeconfig("org-1", "a1", "r1", "kubernetes")).toBeNull();
  });

  it("returns null when the plugin is not registered", async () => {
    mockSelect.mockReturnValue(chainResolving([ACCOUNT]));
    mockGetPlugin.mockResolvedValue(null);
    expect(await resolveKubeconfig("org-1", "a1", "r1", "kubernetes")).toBeNull();
  });

  it("returns null when no peer integration matches", async () => {
    mockSelect
      .mockReturnValueOnce(chainResolving([ACCOUNT]))
      .mockReturnValueOnce(chainResolving([{ resourceTypeId: "gke-cluster" }]));
    mockGetPlugin.mockResolvedValue({
      plugin: {
        manifest: { id: "google-cloud" },
        createClient: () => ({ resolveOutput: vi.fn() }),
        resourceTypes: [
          { id: "gke-cluster", peerIntegrations: [{ pluginId: "other", credentialMappings: [] }] },
        ],
      },
    });
    expect(await resolveKubeconfig("org-1", "a1", "r1", "kubernetes")).toBeNull();
  });

  it("resolves the kubeconfig credential from the peer integration", async () => {
    mockSelect
      .mockReturnValueOnce(chainResolving([ACCOUNT]))
      .mockReturnValueOnce(chainResolving([{ resourceTypeId: "gke-cluster" }]));
    const resolveOutput = vi.fn().mockResolvedValue("apiVersion: v1\nkind: Config");
    mockGetPlugin.mockResolvedValue({
      plugin: {
        manifest: { id: "google-cloud" },
        createClient: () => ({ resolveOutput }),
        resourceTypes: [
          {
            id: "gke-cluster",
            peerIntegrations: [
              {
                pluginId: "kubernetes",
                credentialMappings: [{ outputKey: "kubeconfig", credentialKey: "kubeconfig" }],
              },
            ],
          },
        ],
      },
    });
    const out = await resolveKubeconfig("org-1", "a1", "r1", "kubernetes");
    expect(out).toContain("kind: Config");
    expect(resolveOutput).toHaveBeenCalledWith("gke-cluster", "r1", "kubeconfig", "a1");
  });

  it("returns null when the integration resolves no kubeconfig key", async () => {
    mockSelect
      .mockReturnValueOnce(chainResolving([ACCOUNT]))
      .mockReturnValueOnce(chainResolving([{ resourceTypeId: "gke-cluster" }]));
    mockGetPlugin.mockResolvedValue({
      plugin: {
        manifest: { id: "google-cloud" },
        createClient: () => ({ resolveOutput: vi.fn().mockRejectedValue(new Error("x")) }),
        resourceTypes: [
          {
            id: "gke-cluster",
            peerIntegrations: [
              {
                pluginId: "kubernetes",
                credentialMappings: [{ outputKey: "kubeconfig", credentialKey: "kubeconfig" }],
              },
            ],
          },
        ],
      },
    });
    expect(await resolveKubeconfig("org-1", "a1", "r1", "kubernetes")).toBeNull();
  });
});
