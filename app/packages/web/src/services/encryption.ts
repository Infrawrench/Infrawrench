/**
 * AES-256-GCM encryption for secrets at rest.
 * Ciphertext is stored as base64 text — no binary columns needed.
 */

function getMasterKey(): Buffer {
  const raw = process.env["ENCRYPTION_MASTER_KEY"];
  if (!raw) throw new Error("ENCRYPTION_MASTER_KEY environment variable is required");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("ENCRYPTION_MASTER_KEY must be exactly 32 bytes (256 bits)");
  return buf;
}

export interface Encrypted {
  /** base64-encoded AES-256-GCM ciphertext + 16-byte auth tag appended */
  ciphertext: string;
  /** base64-encoded 96-bit IV */
  iv: string;
}

export async function encrypt(plaintext: string): Promise<Encrypted> {
  const { createCipheriv, randomBytes } = await import("node:crypto");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getMasterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([encrypted, tag]).toString("base64");
  return { ciphertext, iv: iv.toString("base64") };
}

export async function decrypt(ciphertext: string, ivBase64: string): Promise<string> {
  const { createDecipheriv } = await import("node:crypto");
  const buf = Buffer.from(ciphertext, "base64");
  const iv = Buffer.from(ivBase64, "base64");
  const tag = buf.subarray(buf.length - 16);
  const data = buf.subarray(0, buf.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", getMasterKey(), iv);
  decipher.setAuthTag(tag);
  return decipher.update(data) + decipher.final("utf8");
}
