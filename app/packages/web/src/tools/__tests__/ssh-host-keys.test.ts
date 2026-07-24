import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
const mockDelete = vi.fn();
vi.mock("../../db/client", () => ({
  db: {
    select: (...a: unknown[]) => mockSelect(...a),
    delete: (...a: unknown[]) => mockDelete(...a),
  },
}));
vi.mock("../../db/schema", () => ({
  sshHostKeys: {
    id: "id",
    organizationId: "org",
    host: "host",
    port: "port",
    fingerprint: "fp",
    createdAt: "ts",
  },
}));

const mockTrustHostKey = vi.fn();
vi.mock("../../services/ssh-host-keys", () => ({
  trustHostKey: (...a: unknown[]) => mockTrustHostKey(...a),
  HostKeyMismatchError: class HostKeyMismatchError extends Error {
    storedFingerprint: string;
    presentedFingerprint: string;
    constructor(host: string, _port: number, stored: string, presented: string) {
      super(`mismatch for ${host}`);
      this.storedFingerprint = stored;
      this.presentedFingerprint = presented;
    }
  },
}));

const mockLogAudit = vi.fn();
vi.mock("../../services/audit", () => ({
  logAudit: (...a: unknown[]) => mockLogAudit(...a),
}));

const mockResolvePerms = vi.fn();
vi.mock("@infrawrench/server-core/permissions", () => ({
  resolveEffectivePermissions: (...a: unknown[]) => mockResolvePerms(...a),
}));

const { sshHostKeyTools } = await import("../ssh-host-keys");
const { HostKeyMismatchError } = await import("../../services/ssh-host-keys");
const tools = sshHostKeyTools();
const tool = (name: string) => tools.find((t) => t.name === name)!;
const auth = { userId: "u1", organizationId: "o1", source: "mcp" as const };

function grant(...permissions: string[]) {
  mockResolvePerms.mockResolvedValue({ permissions, role: null });
}

describe("sshHostKeyTools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("registers the trust tools with expected risk tiers", () => {
    expect(tools.map((t) => [t.name, t.risk])).toEqual([
      ["list_trusted_ssh_hosts", "read"],
      ["trust_ssh_host", "destructive"],
      ["remove_ssh_host_trust", "destructive"],
    ]);
  });

  it("trust_ssh_host denies without accounts:write", async () => {
    grant("accounts:read");
    const res = await tool("trust_ssh_host").handler(
      { host: "h", port: 22, fingerprint: "SHA256:abc" },
      auth,
    );
    expect(res.isError).toBe(true);
    expect(mockTrustHostKey).not.toHaveBeenCalled();
  });

  it("trust_ssh_host validates the fingerprint format", async () => {
    grant("accounts:write");
    const res = await tool("trust_ssh_host").handler(
      { host: "h", port: 22, fingerprint: "md5:whatever" },
      auth,
    );
    expect(res.isError).toBe(true);
    expect(mockTrustHostKey).not.toHaveBeenCalled();
  });

  it("trust_ssh_host pins the fingerprint and audits", async () => {
    grant("accounts:write");
    mockTrustHostKey.mockResolvedValue(undefined);
    const res = await tool("trust_ssh_host").handler(
      { host: "db.example.com", port: 2222, fingerprint: "SHA256:abc123" },
      auth,
    );
    expect(res.isError).toBeUndefined();
    expect(mockTrustHostKey).toHaveBeenCalledWith("o1", "db.example.com", 2222, "SHA256:abc123");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ssh_host_key.trusted",
        entityId: "db.example.com:2222",
      }),
    );
  });

  it("trust_ssh_host audits a replacement when previousFingerprint is passed", async () => {
    grant("accounts:write");
    mockTrustHostKey.mockResolvedValue(undefined);
    await tool("trust_ssh_host").handler(
      {
        host: "h",
        port: 22,
        fingerprint: "SHA256:new",
        previousFingerprint: "SHA256:old",
      },
      auth,
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ssh_host_key.replaced" }),
    );
  });

  it("trust_ssh_host surfaces a concurrent mismatch without auditing", async () => {
    grant("accounts:write");
    mockTrustHostKey.mockRejectedValue(
      new HostKeyMismatchError("h", 22, "SHA256:stored", "SHA256:presented"),
    );
    const res = await tool("trust_ssh_host").handler(
      { host: "h", port: 22, fingerprint: "SHA256:abc" },
      auth,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("SHA256:stored");
    expect(res.content[0]!.text).toContain("SHA256:presented");
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("remove_ssh_host_trust deletes the pin and audits", async () => {
    grant("accounts:write");
    const returning = vi.fn().mockResolvedValue([{ fingerprint: "SHA256:abc" }]);
    const where = vi.fn().mockReturnValue({ returning });
    mockDelete.mockReturnValue({ where });

    const res = await tool("remove_ssh_host_trust").handler({ host: "h", port: 22 }, auth);
    expect(res.isError).toBeUndefined();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ssh_host_key.removed", entityId: "h:22" }),
    );
  });

  it("remove_ssh_host_trust errors when no pin exists", async () => {
    grant("accounts:write");
    const returning = vi.fn().mockResolvedValue([]);
    const where = vi.fn().mockReturnValue({ returning });
    mockDelete.mockReturnValue({ where });

    const res = await tool("remove_ssh_host_trust").handler({ host: "h", port: 22 }, auth);
    expect(res.isError).toBe(true);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("list_trusted_ssh_hosts returns the pins", async () => {
    grant("accounts:read");
    const orderBy = vi
      .fn()
      .mockResolvedValue([
        { id: "p1", host: "h", port: 22, fingerprint: "SHA256:abc", createdAt: new Date() },
      ]);
    const where = vi.fn().mockReturnValue({ orderBy });
    const from = vi.fn().mockReturnValue({ where });
    mockSelect.mockReturnValue({ from });

    const res = await tool("list_trusted_ssh_hosts").handler({}, auth);
    expect(res.isError).toBeUndefined();
    const pins = JSON.parse(res.content[0]!.text) as Array<{ host: string }>;
    expect(pins[0]!.host).toBe("h");
  });
});
