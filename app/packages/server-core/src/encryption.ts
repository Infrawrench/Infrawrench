/**
 * AES-256-GCM encryption for secrets at rest.
 *
 * Wire format
 * -----------
 * The stored `ciphertext` value is a string. Two versions exist:
 *
 *   v1 (legacy): `<base64(ciphertext || authTag)>`
 *     - No AAD.
 *     - Format predates this module's versioning support; emitted only by
 *       reading paths now. Still readable for backward compatibility.
 *
 *   v2 (current): `v2:<base64(ciphertext || authTag)>`
 *     - AAD-bound: caller must pass a context AAD (e.g.
 *       `account:<accountId>:credentials`). The AAD is *not* stored; the
 *       caller must reproduce it at decrypt time. This binds the ciphertext
 *       to its row + field and prevents row-substitution attacks.
 *     - The `v2:` literal prefix is invalid base64, so disambiguation from
 *       v1 is unambiguous.
 *
 * The `iv` value is always raw base64 of the 12-byte IV; it has no version
 * marker (it's content-addressed by the ciphertext version).
 *
 * Rotation
 * --------
 * To add a new key version in future, introduce `v3:` etc. with its own
 * decode branch. Old rows can be re-encrypted lazily on next write.
 */

function getMasterKey(): Buffer {
  const raw = process.env["ENCRYPTION_MASTER_KEY"];
  if (!raw) throw new Error("ENCRYPTION_MASTER_KEY environment variable is required");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32)
    throw new Error("ENCRYPTION_MASTER_KEY must be exactly 32 bytes (256 bits)");
  return buf;
}

interface Encrypted {
  /** Versioned, base64-encoded AES-256-GCM ciphertext + 16-byte auth tag. */
  ciphertext: string;
  /** base64-encoded 96-bit IV */
  iv: string;
}

const V2_PREFIX = "v2:";

/**
 * Build a context-binding AAD string of the form
 * `<resourceType>:<resourceId>:<fieldName>`. Centralised so encrypt and
 * decrypt callers cannot drift.
 */
export function buildAad(resourceType: string, resourceId: string, fieldName: string): string {
  return `${resourceType}:${resourceId}:${fieldName}`;
}

/**
 * Derive a sub-key for keyed hashing from the master key using HMAC-SHA256
 * with a fixed info string. Re-derived on every call (cheap) so we don't
 * have to manage a cached secret.
 */
async function deriveHmacSubKey(label: string): Promise<Buffer> {
  const { createHmac } = await import("node:crypto");
  return createHmac("sha256", getMasterKey()).update(label).digest();
}

/**
 * Compute a keyed digest of `data` using a sub-key derived from
 * `ENCRYPTION_MASTER_KEY`. Suitable for hashing high-entropy bearer tokens
 * (e.g. API keys) so that a DB-only leak does not yield offline-attackable
 * hashes — without the master key, the digest cannot be reproduced.
 * `domain` separates sub-keys for different uses (e.g. `"api-key"`).
 */
export async function keyedHash(data: string, domain: string): Promise<string> {
  const { createHmac } = await import("node:crypto");
  const subKey = await deriveHmacSubKey(`infrawrench:${domain}:v1`);
  return createHmac("sha256", subKey).update(data).digest("hex");
}

/**
 * Legacy plain SHA-256 of `data` as hex. Used only to look up existing API
 * keys that pre-date keyed hashing — new writes use {@link keyedHash}.
 * TODO: drop this once all rows have been rehashed.
 */
export async function legacySha256Hex(data: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Encrypt `plaintext` under the master key, binding it to `aad`. The AAD
 * must be reproduced at decrypt time. Use a context-specific value such as
 * `account:<accountId>:credentials` or `sshKey:<keyId>:privateKey` so a
 * ciphertext from one row cannot be swapped into another.
 *
 * The returned `ciphertext` is prefixed with `v2:` to mark the format.
 */
export async function encrypt(plaintext: string, aad: string | Buffer): Promise<Encrypted> {
  const { createCipheriv, randomBytes } = await import("node:crypto");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getMasterKey(), iv);
  cipher.setAAD(Buffer.isBuffer(aad) ? aad : Buffer.from(aad, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ciphertext = V2_PREFIX + Buffer.concat([encrypted, tag]).toString("base64");
  return { ciphertext, iv: iv.toString("base64") };
}

/**
 * Decrypt a stored ciphertext. Branches on the wire-format version:
 *   - `v2:<base64>` — AAD-bound. Caller MUST supply the same AAD used at
 *     encrypt time; an incorrect or missing AAD causes auth-tag failure.
 *   - bare `<base64>` — legacy v1 record with no AAD. The supplied `aad`
 *     is ignored. New writes never produce this format.
 *
 * `aad` is optional only to ease incremental rollout to callers; for v2
 * data it is required and ignoring it will throw.
 */
export async function decrypt(
  ciphertext: string,
  ivBase64: string,
  aad?: string | Buffer,
): Promise<string> {
  const { createDecipheriv } = await import("node:crypto");
  const iv = Buffer.from(ivBase64, "base64");

  let payload: Buffer;
  let isV2: boolean;
  if (ciphertext.startsWith(V2_PREFIX)) {
    payload = Buffer.from(ciphertext.slice(V2_PREFIX.length), "base64");
    isV2 = true;
  } else {
    payload = Buffer.from(ciphertext, "base64");
    isV2 = false;
  }

  const tag = payload.subarray(payload.length - 16);
  const data = payload.subarray(0, payload.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", getMasterKey(), iv);
  if (isV2) {
    if (aad == null) {
      throw new Error("AAD is required to decrypt v2 ciphertext");
    }
    decipher.setAAD(Buffer.isBuffer(aad) ? aad : Buffer.from(aad, "utf8"));
  }
  decipher.setAuthTag(tag);
  return decipher.update(data) + decipher.final("utf8");
}
