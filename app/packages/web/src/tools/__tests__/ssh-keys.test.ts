import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockDelete = vi.fn();
vi.mock("../../db/client", () => ({
  db: {
    select: (...a: unknown[]) => mockSelect(...a),
    insert: (...a: unknown[]) => mockInsert(...a),
    delete: (...a: unknown[]) => mockDelete(...a),
  },
}));
vi.mock("../../db/schema", () => ({
  sshKeys: {
    id: "id",
    organizationId: "org",
    userId: "user",
    name: "name",
    keyType: "keyType",
    isImported: "isImported",
    fingerprint: "fingerprint",
    encryptedPublicKey: "encPub",
    publicKeyIv: "pubIv",
    createdAt: "createdAt",
  },
  users: { id: "id", email: "email" },
}));

vi.mock("../../services/encryption", () => ({
  encrypt: (plaintext: string) => Promise.resolve({ ciphertext: `enc(${plaintext})`, iv: "iv" }),
  decrypt: (ciphertext: string) =>
    Promise.resolve(ciphertext.replace(/^enc\(/, "").replace(/\)$/, "")),
  buildAad: (...parts: string[]) => parts.join(":"),
}));

const mockLogAudit = vi.fn();
vi.mock("../../services/audit", () => ({
  logAudit: (...a: unknown[]) => mockLogAudit(...a),
}));

vi.mock("@infrawrench/ssh-tunnel-core", () => ({
  generateEd25519OpenSshKeyPair: () =>
    Promise.resolve({ publicKey: "ssh-ed25519 AAAAGENERATED test", privateKey: "PRIVATE-KEY" }),
  computeSshPublicKeyFingerprint: () => "SHA256:fingerprint",
}));

const mockResolvePerms = vi.fn();
vi.mock("@infrawrench/server-core/permissions", () => ({
  resolveEffectivePermissions: (...a: unknown[]) => mockResolvePerms(...a),
}));

const { sshKeyTools } = await import("../ssh-keys");
const tools = sshKeyTools();
const tool = (name: string) => tools.find((t) => t.name === name)!;
const auth = { userId: "u1", organizationId: "o1", source: "mcp" as const };

function grant(...permissions: string[]) {
  mockResolvePerms.mockResolvedValue({ permissions, role: null });
}

/** A structurally valid OpenSSH ed25519 public key for the real validator. */
function validOpenSshKey(): string {
  const type = "ssh-ed25519";
  const blob = Buffer.concat([
    Buffer.from([0, 0, 0, type.length]),
    Buffer.from(type),
    Buffer.alloc(32),
  ]);
  return `${type} ${blob.toString("base64")} test@host`;
}

describe("sshKeyTools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("registers the four ssh-key tools with expected risk tiers", () => {
    expect(tools.map((t) => [t.name, t.risk])).toEqual([
      ["list_ssh_keys", "read"],
      ["create_ssh_key", "write"],
      ["import_ssh_key", "write"],
      ["delete_ssh_key", "destructive"],
    ]);
  });

  it("list_ssh_keys denies without ssh-keys:read", async () => {
    grant();
    const res = await tool("list_ssh_keys").handler({}, auth);
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("ssh-keys:read");
  });

  it("list_ssh_keys returns decrypted public keys", async () => {
    grant("ssh-keys:read");
    const orderBy = vi.fn().mockResolvedValue([
      {
        id: "k1",
        name: "deploy",
        keyType: "ssh-ed25519",
        isImported: false,
        fingerprint: "SHA256:abc",
        encryptedPublicKey: "enc(ssh-ed25519 AAAA k)",
        publicKeyIv: "iv",
        userId: "u1",
        userEmail: "a@b.c",
        createdAt: new Date("2026-07-01T00:00:00Z"),
      },
    ]);
    const where = vi.fn().mockReturnValue({ orderBy });
    const innerJoin = vi.fn().mockReturnValue({ where });
    const from = vi.fn().mockReturnValue({ innerJoin });
    mockSelect.mockReturnValue({ from });

    const res = await tool("list_ssh_keys").handler({}, auth);
    expect(res.isError).toBeUndefined();
    const keys = JSON.parse(res.content[0]!.text) as Array<Record<string, unknown>>;
    expect(keys[0]).toMatchObject({
      id: "k1",
      publicKey: "ssh-ed25519 AAAA k",
      ownerEmail: "a@b.c",
    });
  });

  it("create_ssh_key stores the key but never returns the private key", async () => {
    grant("ssh-keys:write");
    const values = vi.fn().mockResolvedValue(undefined);
    mockInsert.mockReturnValue({ values });

    const res = await tool("create_ssh_key").handler({ name: "ci key" }, auth);
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).not.toContain("PRIVATE-KEY");
    const out = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
    expect(out["publicKey"]).toBe("ssh-ed25519 AAAAGENERATED test");
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "o1",
        userId: "u1",
        name: "ci key",
        isImported: false,
        encryptedPrivateKey: "enc(PRIVATE-KEY)",
      }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ssh-key.create" }),
    );
  });

  it("import_ssh_key rejects an invalid public key", async () => {
    grant("ssh-keys:write");
    const res = await tool("import_ssh_key").handler({ name: "bad", publicKey: "not-a-key" }, auth);
    expect(res.isError).toBe(true);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("import_ssh_key stores a valid public key", async () => {
    grant("ssh-keys:write");
    const values = vi.fn().mockResolvedValue(undefined);
    mockInsert.mockReturnValue({ values });

    const res = await tool("import_ssh_key").handler(
      { name: "laptop", publicKey: validOpenSshKey() },
      auth,
    );
    expect(res.isError).toBeUndefined();
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ isImported: true, keyType: "ssh-ed25519" }),
    );
  });

  it("delete_ssh_key errors when nothing matched (not owner, no admin)", async () => {
    grant("ssh-keys:write");
    const returning = vi.fn().mockResolvedValue([]);
    const where = vi.fn().mockReturnValue({ returning });
    mockDelete.mockReturnValue({ where });

    const res = await tool("delete_ssh_key").handler({ sshKeyId: "k9" }, auth);
    expect(res.isError).toBe(true);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("delete_ssh_key deletes and audits on success", async () => {
    grant("ssh-keys:write", "team:role:write");
    const returning = vi.fn().mockResolvedValue([{ id: "k9" }]);
    const where = vi.fn().mockReturnValue({ returning });
    mockDelete.mockReturnValue({ where });

    const res = await tool("delete_ssh_key").handler({ sshKeyId: "k9" }, auth);
    expect(res.isError).toBeUndefined();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ssh-key.delete", entityId: "k9" }),
    );
  });
});
