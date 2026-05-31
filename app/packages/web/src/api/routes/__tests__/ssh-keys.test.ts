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
});
