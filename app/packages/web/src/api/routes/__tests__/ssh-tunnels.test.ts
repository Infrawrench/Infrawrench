import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

const mockSelect = vi.fn();
const mockInsert = vi.fn();
vi.mock("@/db/client", () => ({
  db: {
    select: (...a: unknown[]) => mockSelect(...a),
    insert: (...a: unknown[]) => mockInsert(...a),
  },
}));

vi.mock("@/services/encryption", () => ({
  encrypt: vi.fn().mockResolvedValue({ ciphertext: "enc", iv: "iv" }),
  decrypt: vi.fn().mockResolvedValue("-----BEGIN OPENSSH PRIVATE KEY-----"),
  buildAad: vi.fn().mockReturnValue("aad"),
}));

const mockOpenTunnel = vi.fn();
const mockCloseTunnel = vi.fn();
const mockGetActiveTunnels = vi.fn();
vi.mock("@/services/ssh-tunnel", () => ({
  openTunnel: (...a: unknown[]) => mockOpenTunnel(...a),
  closeTunnel: (...a: unknown[]) => mockCloseTunnel(...a),
  getActiveTunnels: (...a: unknown[]) => mockGetActiveTunnels(...a),
}));

const mockSshExec = vi.fn();
vi.mock("@/services/ssh", () => ({ sshExec: (...a: unknown[]) => mockSshExec(...a) }));

class HostKeyTrustRequiredError extends Error {
  kind = "unknown" as const;
  host = "h";
  port = 22;
  presentedFingerprint = "SHA256:p";
  storedFingerprint = null;
}
vi.mock("@/services/ssh-host-keys", () => ({ HostKeyTrustRequiredError }));

const mockResolveSafeHost = vi.fn();
vi.mock("@/services/host-validation", () => ({
  resolveSafeHost: (...a: unknown[]) => mockResolveSafeHost(...a),
}));

const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));

vi.mock("uuid", () => ({ v4: () => "tunnel-uuid-1" }));

const { sshTunnelRoutes } = await import("@/api/routes/ssh-tunnels");
const buildApp = () => buildTestApp(sshTunnelRoutes);

const KEY_ROW = { encryptedPrivateKey: "enc", privateKeyIv: "iv" };

describe("SSH tunnel routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSafeHost.mockResolvedValue("198.51.100.7");
  });

  function selectKey(rows: unknown[]) {
    const limit = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    mockSelect.mockReturnValue({ from });
  }

  describe("POST /create-account", () => {
    const body = {
      sshHost: "bastion.example.com",
      sshPort: 22,
      sshUser: "ubuntu",
      sshKeyId: "k1",
      remoteHost: "10.0.0.5",
      remotePort: 5432,
      pluginId: "postgres",
      displayName: "DB via tunnel",
      credentials: { user: "pg" },
    };

    it("rejects an internal SSH host with 400", async () => {
      mockResolveSafeHost.mockRejectedValue(new Error("host resolves to private range"));
      const res = await buildApp().request("/create-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    });

    it("404s when the SSH key is not owned by the caller", async () => {
      selectKey([]);
      const res = await buildApp().request("/create-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(404);
    });

    it("persists account + tunnel config after a successful tunnel test", async () => {
      selectKey([KEY_ROW]);
      mockOpenTunnel.mockResolvedValue({ localPort: 12345 });
      const values = vi.fn().mockResolvedValue(undefined);
      mockInsert.mockReturnValue({ values });

      const res = await buildApp().request("/create-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).accountId).toBeDefined();
      // accounts + sshTunnelConfigs inserts
      expect(mockInsert).toHaveBeenCalledTimes(2);
    });

    it("returns 409 when openTunnel raises a host-key trust error", async () => {
      selectKey([KEY_ROW]);
      mockOpenTunnel.mockRejectedValue(new HostKeyTrustRequiredError());
      const res = await buildApp().request("/create-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(409);
    });

    it("returns 400 when openTunnel fails for another reason", async () => {
      selectKey([KEY_ROW]);
      mockOpenTunnel.mockRejectedValue(new Error("connection refused"));
      const res = await buildApp().request("/create-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/SSH tunnel failed/);
    });
  });

  describe("POST /open", () => {
    it("404s when no config exists for the account", async () => {
      selectKey([]);
      const res = await buildApp().request("/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: "a1" }),
      });
      expect(res.status).toBe(404);
    });

    it("opens a tunnel for a stored config", async () => {
      selectKey([
        {
          id: "cfg1",
          sshHost: "bastion",
          sshPort: 22,
          sshUser: "ubuntu",
          remoteHost: "10.0.0.5",
          remotePort: 5432,
          encryptedPrivateKey: "enc",
          privateKeyIv: "iv",
        },
      ]);
      mockOpenTunnel.mockResolvedValue({ localPort: 99 });
      const res = await buildApp().request("/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: "a1" }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).localPort).toBe(99);
    });
  });

  describe("POST /close", () => {
    it("closes the given tunnel id", async () => {
      const res = await buildApp().request("/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tunnelId: "t1" }),
      });
      expect(res.status).toBe(200);
      expect(mockCloseTunnel).toHaveBeenCalledWith("t1");
    });
  });

  describe("GET /active", () => {
    it("returns only tunnels belonging to the caller's org", async () => {
      mockGetActiveTunnels.mockReturnValue({
        t1: { organizationId: "org-1", localPort: 1, sshHost: "h1", remotePort: 5432 },
        t2: { organizationId: "other-org", localPort: 2, sshHost: "h2", remotePort: 6379 },
      });
      const res = await buildApp().request("/active");
      const body = await res.json();
      expect(Object.keys(body)).toEqual(["t1"]);
    });
  });

  describe("POST /exec", () => {
    const execBody = {
      sshHost: "bastion",
      sshPort: 22,
      sshUser: "ubuntu",
      sshKeyId: "k1",
      command: "uptime",
    };

    it("returns 403 when no matching tunnel config is configured", async () => {
      // matchingConfigs lookup → empty
      selectKey([]);
      const res = await buildApp().request("/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(execBody),
      });
      expect(res.status).toBe(403);
    });

    it("executes and audit-logs success", async () => {
      // first select: matching configs; second select: key row.
      const cfgLimit = vi.fn().mockResolvedValue([{ id: "cfg1", accountId: "a1" }]);
      const cfgWhere = vi.fn().mockReturnValue({ limit: cfgLimit });
      const cfgFrom = vi.fn().mockReturnValue({ where: cfgWhere });
      const keyLimit = vi.fn().mockResolvedValue([KEY_ROW]);
      const keyWhere = vi.fn().mockReturnValue({ limit: keyLimit });
      const keyFrom = vi.fn().mockReturnValue({ where: keyWhere });
      mockSelect.mockReturnValueOnce({ from: cfgFrom }).mockReturnValueOnce({ from: keyFrom });
      mockSshExec.mockResolvedValue("up 3 days");

      const res = await buildApp().request("/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(execBody),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ stdout: "up 3 days", code: 0 });
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "ssh.exec" }));
      // Nothing downstream re-resolves for this route, so the address the
      // guard cleared has to travel with the config — the name is resolved
      // once, and `host` stays the name for host-key trust.
      expect(mockSshExec).toHaveBeenCalledWith(
        "org-1",
        expect.objectContaining({ host: "bastion" }),
        "uptime",
        { dialAddress: "198.51.100.7" },
      );
    });

    it("returns stderr + code 1 and audit-logs failure on a command error", async () => {
      const cfgLimit = vi.fn().mockResolvedValue([{ id: "cfg1", accountId: "a1" }]);
      const cfgWhere = vi.fn().mockReturnValue({ limit: cfgLimit });
      const cfgFrom = vi.fn().mockReturnValue({ where: cfgWhere });
      const keyLimit = vi.fn().mockResolvedValue([KEY_ROW]);
      const keyWhere = vi.fn().mockReturnValue({ limit: keyLimit });
      const keyFrom = vi.fn().mockReturnValue({ where: keyWhere });
      mockSelect.mockReturnValueOnce({ from: cfgFrom }).mockReturnValueOnce({ from: keyFrom });
      mockSshExec.mockRejectedValue(new Error("exit 1"));

      const res = await buildApp().request("/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(execBody),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).code).toBe(1);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "ssh.exec.failed" }),
      );
    });
  });
});
