import { describe, it, expect, beforeAll } from "vitest";
import { encrypt, decrypt } from "../encryption";
import { randomBytes } from "node:crypto";

beforeAll(() => {
  // 32 random bytes encoded as base64
  const key = randomBytes(32).toString("base64");
  process.env["ENCRYPTION_MASTER_KEY"] = key;
});

describe("encrypt / decrypt", () => {
  it("roundtrips plaintext correctly", async () => {
    const plaintext = "hello, infrawrench!";
    const { ciphertext, iv } = await encrypt(plaintext);
    const decrypted = await decrypt(ciphertext, iv);
    expect(decrypted).toBe(plaintext);
  });

  it("produces a different IV each time", async () => {
    const a = await encrypt("same");
    const b = await encrypt("same");
    expect(a.iv).not.toBe(b.iv);
  });

  it("fails to decrypt with a wrong IV", async () => {
    const { ciphertext } = await encrypt("secret");
    const wrongIv = randomBytes(12).toString("base64");
    await expect(decrypt(ciphertext, wrongIv)).rejects.toThrow();
  });
});
