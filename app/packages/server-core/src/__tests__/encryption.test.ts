import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

const KEY = randomBytes(32).toString("base64");

describe("encryption", () => {
  let buildAad: typeof import("../encryption").buildAad;
  let encrypt: typeof import("../encryption").encrypt;
  let decrypt: typeof import("../encryption").decrypt;
  let keyedHash: typeof import("../encryption").keyedHash;
  let legacySha256Hex: typeof import("../encryption").legacySha256Hex;

  beforeEach(async () => {
    process.env["ENCRYPTION_MASTER_KEY"] = KEY;
    const mod = await import("../encryption");
    buildAad = mod.buildAad;
    encrypt = mod.encrypt;
    decrypt = mod.decrypt;
    keyedHash = mod.keyedHash;
    legacySha256Hex = mod.legacySha256Hex;
  });

  afterEach(() => {
    process.env["ENCRYPTION_MASTER_KEY"] = KEY;
  });

  describe("buildAad", () => {
    it("joins parts with colons", () => {
      expect(buildAad("account", "abc", "credentials")).toBe("account:abc:credentials");
    });
  });

  describe("encrypt/decrypt round-trip", () => {
    it("round-trips a v2 ciphertext with matching AAD", async () => {
      const aad = buildAad("account", "id1", "credentials");
      const { ciphertext, iv } = await encrypt("hello world", aad);
      expect(ciphertext.startsWith("v2:")).toBe(true);
      const out = await decrypt(ciphertext, iv, aad);
      expect(out).toBe("hello world");
    });

    it("accepts a Buffer AAD", async () => {
      const aad = Buffer.from("buffer-aad");
      const { ciphertext, iv } = await encrypt("payload", aad);
      const out = await decrypt(ciphertext, iv, aad);
      expect(out).toBe("payload");
    });

    it("round-trips unicode", async () => {
      const aad = "a:b:c";
      const { ciphertext, iv } = await encrypt("héllo 🌍 mündo", aad);
      expect(await decrypt(ciphertext, iv, aad)).toBe("héllo 🌍 mündo");
    });

    it("produces a different IV / ciphertext each call", async () => {
      const aad = "a:b:c";
      const a = await encrypt("same", aad);
      const b = await encrypt("same", aad);
      expect(a.iv).not.toBe(b.iv);
      expect(a.ciphertext).not.toBe(b.ciphertext);
    });
  });

  describe("decrypt error / tamper cases", () => {
    it("throws when v2 AAD does not match", async () => {
      const { ciphertext, iv } = await encrypt("secret", "account:id1:credentials");
      await expect(decrypt(ciphertext, iv, "account:id2:credentials")).rejects.toThrow();
    });

    it("throws when the ciphertext body is tampered", async () => {
      const aad = "a:b:c";
      const { ciphertext, iv } = await encrypt("secret", aad);
      // Flip a byte in the base64 payload.
      const raw = Buffer.from(ciphertext.slice(3), "base64");
      raw[0] = raw[0]! ^ 0xff;
      const tampered = "v2:" + raw.toString("base64");
      await expect(decrypt(tampered, iv, aad)).rejects.toThrow();
    });

    it("throws when the IV is wrong", async () => {
      const aad = "a:b:c";
      const { ciphertext } = await encrypt("secret", aad);
      const badIv = randomBytes(12).toString("base64");
      await expect(decrypt(ciphertext, badIv, aad)).rejects.toThrow();
    });
  });

  describe("master key validation", () => {
    it("throws when the key is absent", async () => {
      delete process.env["ENCRYPTION_MASTER_KEY"];
      await expect(encrypt("x", "a:b:c")).rejects.toThrow(/required/);
    });

    it("throws when the key is not 32 bytes", async () => {
      process.env["ENCRYPTION_MASTER_KEY"] = randomBytes(16).toString("base64");
      await expect(encrypt("x", "a:b:c")).rejects.toThrow(/32 bytes/);
    });
  });

  describe("keyedHash", () => {
    it("is deterministic for the same input + domain", async () => {
      const a = await keyedHash("token-123", "api-key");
      const b = await keyedHash("token-123", "api-key");
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
    });

    it("differs across domains", async () => {
      const a = await keyedHash("token-123", "api-key");
      const b = await keyedHash("token-123", "other");
      expect(a).not.toBe(b);
    });

    it("differs across inputs", async () => {
      const a = await keyedHash("token-a", "api-key");
      const b = await keyedHash("token-b", "api-key");
      expect(a).not.toBe(b);
    });
  });

  describe("legacySha256Hex", () => {
    it("computes a plain sha256 hex independent of the master key", async () => {
      // sha256("abc")
      expect(await legacySha256Hex("abc")).toBe(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      );
    });
  });
});
