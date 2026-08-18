import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockDelete = vi.fn();
vi.mock("@/db/client", () => ({
  db: {
    select: (...a: unknown[]) => mockSelect(...a),
    insert: (...a: unknown[]) => mockInsert(...a),
    delete: (...a: unknown[]) => mockDelete(...a),
  },
}));

vi.mock("@/services/encryption", () => ({
  encrypt: vi.fn().mockResolvedValue({ ciphertext: "enc", iv: "iv" }),
  decrypt: vi.fn().mockResolvedValue("ssh-ed25519 AAAA decrypted-key"),
  buildAad: vi.fn().mockReturnValue("aad"),
}));

const mockHasPermission = vi.fn();
vi.mock("@infrawrench/server-core/permissions", () => ({
  hasPermission: (...a: unknown[]) => mockHasPermission(...a),
}));

const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({
  logAudit: (...a: unknown[]) => mockLogAudit(...a),
}));

const { sshKeyRoutes } = await import("@/api/routes/ssh-keys");
const buildApp = () => buildTestApp(sshKeyRoutes);

describe("SSH key routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasPermission.mockReturnValue(false);
  });

  describe("GET /", () => {
    it("returns keys with decrypted public key and no private material", async () => {
      const orderBy = vi.fn().mockResolvedValue([
        {
          id: "k1",
          name: "deploy",
          keyType: "ssh-ed25519",
          isImported: false,
          fingerprint: "SHA256:x",
          encryptedPublicKey: "enc",
          publicKeyIv: "iv",
          userId: "user-1",
          userEmail: "a@b.com",
          userDisplayName: "Alice",
          createdAt: new Date("2026-01-01T00:00:00Z"),
        },
      ]);
      const where = vi.fn().mockReturnValue({ orderBy });
      const innerJoin = vi.fn().mockReturnValue({ where });
      const from = vi.fn().mockReturnValue({ innerJoin });
      mockSelect.mockReturnValue({ from });

      const res = await buildApp().request("/");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body[0]).toMatchObject({
        id: "k1",
        ownerName: "Alice",
        publicKey: expect.any(String),
      });
      expect(body[0]).not.toHaveProperty("encryptedPublicKey");
    });
  });

  describe("POST / — generate", () => {
    it("generates an ed25519 keypair and returns the private key once", async () => {
      const values = vi.fn().mockResolvedValue(undefined);
      mockInsert.mockReturnValue({ values });

      const res = await buildApp().request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "ci" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keyType).toBe("ssh-ed25519");
      expect(body.publicKey).toMatch(/^ssh-ed25519 /);
      expect(body.privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
      expect(body.fingerprint).toMatch(/^SHA256:/);
    });

    it("rejects a blank name", async () => {
      const res = await buildApp().request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "  " }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /import", () => {
    // A real ed25519 public key blob: type-string "ssh-ed25519" + 32-byte key.
    function makeEd25519PubKey(name: string): string {
      const type = Buffer.from("ssh-ed25519");
      const typeLen = Buffer.alloc(4);
      typeLen.writeUInt32BE(type.length);
      const keyLen = Buffer.alloc(4);
      keyLen.writeUInt32BE(32);
      const blob = Buffer.concat([typeLen, type, keyLen, Buffer.alloc(32, 9)]);
      return `ssh-ed25519 ${blob.toString("base64")} ${name}`;
    }

    it("imports a valid public key", async () => {
      const values = vi.fn().mockResolvedValue(undefined);
      mockInsert.mockReturnValue({ values });

      const res = await buildApp().request("/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "laptop", publicKey: makeEd25519PubKey("laptop") }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keyType).toBe("ssh-ed25519");
      expect(body.isImported).toBe(true);
    });

    it("rejects an unsupported key type with 400", async () => {
      const res = await buildApp().request("/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x", publicKey: "ssh-bogus AAAA comment" }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Unsupported key type/);
    });

    it("rejects a missing public key", async () => {
      const res = await buildApp().request("/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /:id", () => {
    it("deletes the caller's own key", async () => {
      const returning = vi.fn().mockResolvedValue([{ id: "k1" }]);
      const where = vi.fn().mockReturnValue({ returning });
      mockDelete.mockReturnValue({ where });

      const res = await buildApp().request("/k1", { method: "DELETE" });
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
    });

    it("returns 404 when nothing matched", async () => {
      const returning = vi.fn().mockResolvedValue([]);
      const where = vi.fn().mockReturnValue({ returning });
      mockDelete.mockReturnValue({ where });

      const res = await buildApp().request("/k1", { method: "DELETE" });
      expect(res.status).toBe(404);
    });

    it("admins (team:role:write) may delete any org key", async () => {
      mockHasPermission.mockReturnValue(true);
      const returning = vi.fn().mockResolvedValue([{ id: "k1" }]);
      const where = vi.fn().mockReturnValue({ returning });
      mockDelete.mockReturnValue({ where });

      const res = await buildApp().request("/k1", { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(mockHasPermission).toHaveBeenCalledWith(["*"], "team:role:write");
    });
  });

  describe("POST /:id/sign — the cloud as an SSH agent", () => {
    const keyRow = (overrides: Record<string, unknown> = {}) => ({
      id: "k1",
      organizationId: "org-1",
      name: "cloud-key",
      keyType: "ssh-ed25519",
      isImported: false,
      encryptedPrivateKey: "enc-priv",
      privateKeyIv: "iv",
      ...overrides,
    });

    function mockKeyLookup(rows: unknown[]): void {
      const where = vi.fn().mockResolvedValue(rows);
      const from = vi.fn().mockReturnValue({ where });
      mockSelect.mockReturnValue({ from });
    }

    function signRequest(body: Record<string, unknown>) {
      return buildApp().request("/k1/sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("signs a challenge with the decrypted key and audits it", async () => {
      const { generateEd25519OpenSshKeyPair } = await import("@infrawrench/ssh-tunnel-core");
      const { utils } = await import("ssh2");
      const pair = await generateEd25519OpenSshKeyPair("cloud-key");
      const { decrypt } = await import("@/services/encryption");
      vi.mocked(decrypt).mockResolvedValueOnce(pair.privateKey);
      mockKeyLookup([keyRow()]);

      const data = Buffer.from("userauth-challenge");
      const res = await signRequest({
        data: data.toString("base64"),
        algorithm: "ssh-ed25519",
        context: { host: "vm.example.com", username: "root" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.algorithm).toBe("ssh-ed25519");

      const pub = utils.parseKey(pair.publicKey);
      if (pub instanceof Error || Array.isArray(pub)) throw new Error("bad fixture");
      expect(pub.verify(data, Buffer.from(body.signature, "base64"))).toBe(true);

      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "ssh.agent.sign",
          entityType: "ssh-key",
          entityId: "k1",
          metadata: expect.objectContaining({
            sshKeyId: "k1",
            source: "remote-agent",
            sshHost: "vm.example.com",
            sshUsername: "root",
            signatureFormat: "ssh-ed25519",
          }),
        }),
      );
    });

    it("refuses an imported key (no private half) with 400 and a failure audit", async () => {
      mockKeyLookup([keyRow({ isImported: true, encryptedPrivateKey: null, privateKeyIv: null })]);
      const res = await signRequest({
        data: Buffer.from("x").toString("base64"),
        algorithm: "ssh-ed25519",
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/imported/);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "ssh.agent.sign_failed",
          metadata: expect.objectContaining({ failureReason: "no_private_key" }),
        }),
      );
    });

    it("404s for a key outside the org", async () => {
      mockKeyLookup([]);
      const res = await signRequest({
        data: Buffer.from("x").toString("base64"),
        algorithm: "ssh-ed25519",
      });
      expect(res.status).toBe(404);
    });

    it("rejects an unknown algorithm", async () => {
      const res = await signRequest({
        data: Buffer.from("x").toString("base64"),
        algorithm: "ssh-dss",
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing and oversized data", async () => {
      expect((await signRequest({ algorithm: "ssh-ed25519" })).status).toBe(400);
      const huge = Buffer.alloc(17 * 1024).toString("base64");
      expect((await signRequest({ data: huge, algorithm: "ssh-ed25519" })).status).toBe(400);
    });

    it("400s when the key cannot produce the requested algorithm", async () => {
      const { generateEd25519OpenSshKeyPair } = await import("@infrawrench/ssh-tunnel-core");
      const pair = await generateEd25519OpenSshKeyPair("cloud-key");
      const { decrypt } = await import("@/services/encryption");
      vi.mocked(decrypt).mockResolvedValueOnce(pair.privateKey);
      mockKeyLookup([keyRow()]);

      const res = await signRequest({
        data: Buffer.from("x").toString("base64"),
        algorithm: "rsa-sha2-256",
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/cannot produce/);
    });

    it("is gated on resources:execute, not ssh-keys:read", async () => {
      const app = buildTestApp(sshKeyRoutes, ["ssh-keys:read", "ssh-keys:write"]);
      const res = await app.request("/k1/sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: Buffer.from("x").toString("base64"),
          algorithm: "ssh-ed25519",
        }),
      });
      expect(res.status).toBe(403);
    });
  });
});
