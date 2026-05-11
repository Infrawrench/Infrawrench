import { describe, it, expect, beforeAll } from "vitest";
import { encrypt, decrypt, buildAad, keyedHash, legacySha256Hex } from "../encryption";
import { randomBytes, createHash } from "node:crypto";

beforeAll(() => {
  // 32 random bytes encoded as base64
  const key = randomBytes(32).toString("base64");
  process.env["ENCRYPTION_MASTER_KEY"] = key;
});

describe("encrypt / decrypt", () => {
  const aad = buildAad("test", "row-1", "field");

  it("roundtrips plaintext correctly", async () => {
    const plaintext = "hello, infrawrench!";
    const { ciphertext, iv } = await encrypt(plaintext, aad);
    const decrypted = await decrypt(ciphertext, iv, aad);
    expect(decrypted).toBe(plaintext);
  });

  it("produces a different IV each time", async () => {
    const a = await encrypt("same", aad);
    const b = await encrypt("same", aad);
    expect(a.iv).not.toBe(b.iv);
  });

  it("fails to decrypt with a wrong IV", async () => {
    const { ciphertext } = await encrypt("secret", aad);
    const wrongIv = randomBytes(12).toString("base64");
    await expect(decrypt(ciphertext, wrongIv, aad)).rejects.toThrow();
  });

  it("emits a v2-prefixed ciphertext", async () => {
    const { ciphertext } = await encrypt("hello", aad);
    expect(ciphertext.startsWith("v2:")).toBe(true);
  });

  it("fails to decrypt a v2 ciphertext when AAD does not match", async () => {
    const { ciphertext, iv } = await encrypt("secret", aad);
    await expect(decrypt(ciphertext, iv, buildAad("test", "row-2", "field"))).rejects.toThrow();
  });

  it("fails to decrypt a v2 ciphertext when AAD is missing", async () => {
    const { ciphertext, iv } = await encrypt("secret", aad);
    await expect(decrypt(ciphertext, iv)).rejects.toThrow();
  });

  it("still decrypts legacy v1 ciphertext without AAD", async () => {
    // Build a v1 record by hand using node:crypto so we don't accidentally
    // wire-test the v2 path. v1 = base64(ciphertext || authTag), no AAD.
    const { createCipheriv } = await import("node:crypto");
    const iv = randomBytes(12);
    const masterKey = Buffer.from(process.env["ENCRYPTION_MASTER_KEY"]!, "base64");
    const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
    const enc = Buffer.concat([cipher.update("legacy", "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const v1Ciphertext = Buffer.concat([enc, tag]).toString("base64");

    const plaintext = await decrypt(v1Ciphertext, iv.toString("base64"));
    expect(plaintext).toBe("legacy");
  });
});

describe("keyedHash / legacySha256Hex", () => {
  it("keyedHash is stable for the same input + domain", async () => {
    const a = await keyedHash("token", "api-key");
    const b = await keyedHash("token", "api-key");
    expect(a).toBe(b);
  });

  it("keyedHash differs across domains", async () => {
    const a = await keyedHash("token", "api-key");
    const b = await keyedHash("token", "session");
    expect(a).not.toBe(b);
  });

  it("keyedHash differs from raw SHA-256", async () => {
    const keyed = await keyedHash("token", "api-key");
    const legacy = await legacySha256Hex("token");
    expect(keyed).not.toBe(legacy);
    expect(legacy).toBe(createHash("sha256").update("token").digest("hex"));
  });
});
