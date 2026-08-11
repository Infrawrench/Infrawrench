import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

const mockSelect = vi.fn();
vi.mock("@/db/client", () => ({ db: { select: (...a: unknown[]) => mockSelect(...a) } }));

vi.mock("@/services/encryption", () => ({
  decrypt: vi.fn().mockResolvedValue("PRIVATE_KEY"),
  buildAad: vi.fn().mockReturnValue("aad"),
}));

const mockGetPlugin = vi.fn();
vi.mock("@/plugins/loader", () => ({ getPlugin: (...a: unknown[]) => mockGetPlugin(...a) }));

const mockGetClientForAccount = vi.fn();
vi.mock("@/services/plugin-clients", () => ({
  getClientForAccount: (...a: unknown[]) => mockGetClientForAccount(...a),
}));

const mockSshExec = vi.fn();
vi.mock("@/services/ssh", () => ({ sshExec: (...a: unknown[]) => mockSshExec(...a) }));

const mockResolveSafeHost = vi.fn();
vi.mock("@/services/host-validation", () => ({
  resolveSafeHost: (...a: unknown[]) => mockResolveSafeHost(...a),
}));

class HostKeyTrustRequiredError extends Error {
  kind = "unknown" as const;
  host = "h";
  port = 22;
  presentedFingerprint = "SHA256:p";
  storedFingerprint = null;
}
vi.mock("@/services/ssh-host-keys", () => ({ HostKeyTrustRequiredError }));

const { connectRoutes } = await import("@/api/routes/connect");
const buildApp = () => buildTestApp(connectRoutes);

describe("Connect routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSafeHost.mockResolvedValue("198.51.100.11");
  });

  describe("POST /templates", () => {
    it("404s when the source plugin is unknown", async () => {
      mockGetPlugin.mockResolvedValue(null);
      const res = await buildApp().request("/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourcePluginId: "x",
          sourceResourceTypeId: "db",
          targetAccountId: "a1",
          targetPluginId: "k8s",
        }),
      });
      expect(res.status).toBe(404);
    });

    it("returns templates and target capabilities", async () => {
      mockGetPlugin
        .mockResolvedValueOnce({
          plugin: {
            resourceTypes: [{ id: "db", secretExportTemplates: [{ id: "t1", entries: [] }] }],
          },
        })
        .mockResolvedValueOnce({
          plugin: { manifest: { supportsSecretImport: true } },
        });
      mockGetClientForAccount.mockResolvedValue({
        client: { listNamespacesForImport: vi.fn().mockResolvedValue(["default", "prod"]) },
      });

      const res = await buildApp().request("/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourcePluginId: "pg",
          sourceResourceTypeId: "db",
          targetAccountId: "a1",
          targetPluginId: "k8s",
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.templates).toHaveLength(1);
      expect(body.supportsSecretImport).toBe(true);
      expect(body.namespaces).toEqual(["default", "prod"]);
    });
  });

  describe("POST /secret-export", () => {
    const baseBody = {
      sourceAccountId: "a1",
      sourceResourceId: "r1",
      sourcePluginId: "pg",
      sourceResourceTypeId: "db",
      targetAccountId: "a2",
      targetPluginId: "k8s",
      templateId: "t1",
      namespace: "default",
      secretName: "creds",
      keyOverrides: {},
    };

    it("404s when source account not found", async () => {
      mockGetClientForAccount.mockResolvedValue(null);
      const res = await buildApp().request("/secret-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(baseBody),
      });
      expect(res.status).toBe(404);
    });

    it("imports the secret into the target", async () => {
      const importSecret = vi.fn().mockResolvedValue(undefined);
      mockGetClientForAccount
        .mockResolvedValueOnce({
          client: { resolveOutput: vi.fn().mockResolvedValue("pgpass") },
          plugin: {
            resourceTypes: [
              {
                id: "db",
                secretExportTemplates: [
                  { id: "t1", entries: [{ outputKey: "password", envKey: "DB_PASS" }] },
                ],
              },
            ],
          },
        })
        .mockResolvedValueOnce({ client: { importSecret } });

      const res = await buildApp().request("/secret-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(baseBody),
      });
      expect(res.status).toBe(200);
      expect(importSecret).toHaveBeenCalledWith(
        "",
        expect.objectContaining({ secretName: "creds", data: { DB_PASS: "pgpass" } }),
      );
    });

    it("400s when no outputs could be resolved", async () => {
      mockGetClientForAccount.mockResolvedValueOnce({
        client: { resolveOutput: vi.fn().mockRejectedValue(new Error("nope")) },
        plugin: {
          resourceTypes: [
            {
              id: "db",
              secretExportTemplates: [
                { id: "t1", entries: [{ outputKey: "password", envKey: "DB_PASS" }] },
              ],
            },
          ],
        },
      });
      const res = await buildApp().request("/secret-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(baseBody),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /env-deploy", () => {
    const baseBody = {
      sourceAccountId: "a1",
      sourceResourceId: "r1",
      sourcePluginId: "pg",
      sourceResourceTypeId: "db",
      targetSshHost: "host.example.com",
      sshKeyId: "k1",
      sshUsername: "ubuntu",
      templateId: "t1",
      keyOverrides: {},
      format: "dotenv" as const,
      filePath: "/home/ubuntu/.env",
      append: false,
    };

    function sourceCtxWithOutput() {
      mockGetClientForAccount.mockResolvedValue({
        client: { resolveOutput: vi.fn().mockResolvedValue("val") },
        plugin: {
          resourceTypes: [
            {
              id: "db",
              secretExportTemplates: [
                { id: "t1", entries: [{ outputKey: "url", envKey: "DB_URL" }] },
              ],
            },
          ],
        },
      });
    }

    it("rejects an invalid file path", async () => {
      sourceCtxWithOutput();
      const res = await buildApp().request("/env-deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...baseBody, filePath: "/etc/passwd; rm -rf /" }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Invalid filePath/);
    });

    it("404s when the SSH key is missing", async () => {
      sourceCtxWithOutput();
      const limit = vi.fn().mockResolvedValue([]);
      const where = vi.fn().mockReturnValue({ limit });
      const from = vi.fn().mockReturnValue({ where });
      mockSelect.mockReturnValue({ from });

      const res = await buildApp().request("/env-deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(baseBody),
      });
      expect(res.status).toBe(404);
    });

    it("deploys env vars over SSH", async () => {
      sourceCtxWithOutput();
      const limit = vi.fn().mockResolvedValue([{ encryptedPrivateKey: "enc", privateKeyIv: "iv" }]);
      const where = vi.fn().mockReturnValue({ limit });
      const from = vi.fn().mockReturnValue({ where });
      mockSelect.mockReturnValue({ from });
      mockSshExec.mockResolvedValue("");

      const res = await buildApp().request("/env-deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(baseBody),
      });
      expect(res.status).toBe(200);
      expect(mockSshExec).toHaveBeenCalled();
      const cmd = mockSshExec.mock.calls[0]![2] as string;
      expect(cmd).toContain("printf");
      // `targetSshHost` is request body: vetted, then dialed by address while
      // the config keeps the name for host-key trust.
      expect(mockResolveSafeHost).toHaveBeenCalledWith("host.example.com");
      expect(mockSshExec.mock.calls[0]![1]).toMatchObject({ host: "host.example.com" });
      expect(mockSshExec.mock.calls[0]![3]).toEqual({ dialAddress: "198.51.100.11" });
    });

    it("400s on a target host in blocked address space, before decrypting a key", async () => {
      sourceCtxWithOutput();
      mockResolveSafeHost.mockRejectedValue(
        new Error("SSH host 169.254.169.254 resolves to a blocked address range"),
      );

      const res = await buildApp().request("/env-deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...baseBody, targetSshHost: "169.254.169.254" }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/blocked address range/);
      expect(mockSshExec).not.toHaveBeenCalled();
    });
  });
});
