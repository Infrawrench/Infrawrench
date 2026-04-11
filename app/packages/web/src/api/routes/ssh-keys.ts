import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { db } from "../../db/client";
import { sshKeys, users } from "../../db/schema";
import { encrypt, decrypt } from "../../services/encryption";
import type { AuthSession } from "../auth-middleware";

const generateKeyPair = promisify(crypto.generateKeyPair);

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

// ── OpenSSH key format helpers ───────────────────────────────────────────────

/** Write a length-prefixed SSH wire string: uint32be(len) + data */
function sshWireString(type: string, ...bufs: Uint8Array[]): Buffer {
  const typeLen = Buffer.alloc(4);
  typeLen.writeUInt32BE(type.length);
  const parts: Uint8Array[] = [typeLen, Buffer.from(type)];
  for (const buf of bufs) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(buf.length);
    parts.push(len, buf);
  }
  return Buffer.concat(parts);
}

/**
 * Build an unencrypted OpenSSH private key file (same format as `ssh-keygen -t ed25519`).
 * See https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.key
 */
function buildOpenSshPrivateKey(privSeed: Buffer, pubKey: Buffer, comment: string): string {
  const AUTH_MAGIC = "openssh-key-v1\0";
  const cipherName = "none";
  const kdfName = "none";
  const kdfOptions = Buffer.alloc(0);
  const keyCount = 1;

  // Public key blob (same wire format as authorized_keys)
  const pubBlob = sshWireString("ssh-ed25519", pubKey);

  // Private section (unencrypted)
  const checkInt = crypto.randomBytes(4);
  const keyType = Buffer.from("ssh-ed25519");
  const keyTypeLenBuf = Buffer.alloc(4);
  keyTypeLenBuf.writeUInt32BE(keyType.length);
  const pubLenBuf = Buffer.alloc(4);
  pubLenBuf.writeUInt32BE(pubKey.length);
  // Ed25519 private key in OpenSSH = 64 bytes: seed (32) + public (32)
  const fullPriv = Buffer.concat([privSeed, pubKey]);
  const fullPrivLenBuf = Buffer.alloc(4);
  fullPrivLenBuf.writeUInt32BE(fullPriv.length);
  const commentBuf = Buffer.from(comment);
  const commentLenBuf = Buffer.alloc(4);
  commentLenBuf.writeUInt32BE(commentBuf.length);

  const privSection = Buffer.concat([
    checkInt, checkInt, // two identical checkints
    keyTypeLenBuf, keyType,
    pubLenBuf, pubKey,
    fullPrivLenBuf, fullPriv,
    commentLenBuf, commentBuf,
  ]);

  // Pad to 8-byte boundary (cipher block size for "none")
  const padLen = 8 - (privSection.length % 8);
  const padding = Buffer.alloc(padLen === 8 ? 0 : padLen);
  for (let i = 0; i < padding.length; i++) padding[i] = i + 1;
  const paddedPriv = Buffer.concat([privSection, padding]);

  // Assemble the full key file
  const cipherBuf = Buffer.from(cipherName);
  const cipherLenBuf = Buffer.alloc(4);
  cipherLenBuf.writeUInt32BE(cipherBuf.length);
  const kdfBuf = Buffer.from(kdfName);
  const kdfLenBuf = Buffer.alloc(4);
  kdfLenBuf.writeUInt32BE(kdfBuf.length);
  const kdfOptLenBuf = Buffer.alloc(4);
  kdfOptLenBuf.writeUInt32BE(kdfOptions.length);
  const keyCountBuf = Buffer.alloc(4);
  keyCountBuf.writeUInt32BE(keyCount);
  const pubBlobLenBuf = Buffer.alloc(4);
  pubBlobLenBuf.writeUInt32BE(pubBlob.length);
  const privLenBuf = Buffer.alloc(4);
  privLenBuf.writeUInt32BE(paddedPriv.length);

  const full = Buffer.concat([
    Buffer.from(AUTH_MAGIC),
    cipherLenBuf, cipherBuf,
    kdfLenBuf, kdfBuf,
    kdfOptLenBuf, kdfOptions,
    keyCountBuf,
    pubBlobLenBuf, pubBlob,
    privLenBuf, paddedPriv,
  ]);

  // Wrap in PEM-style armor with 70-char lines
  const b64 = full.toString("base64");
  const lines = b64.match(/.{1,70}/g) ?? [];
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

const app = new Hono();

/**
 * GET /api/ssh-keys — list all SSH keys in the org (public keys visible to all members).
 * Returns owner info so the UI can show who owns each key.
 */
app.get("/", async (c) => {
  const organizationId = c.get("organizationId");
  const rows = await db
    .select({
      id: sshKeys.id,
      name: sshKeys.name,
      keyType: sshKeys.keyType,
      encryptedPublicKey: sshKeys.encryptedPublicKey,
      publicKeyIv: sshKeys.publicKeyIv,
      userId: sshKeys.userId,
      userEmail: users.email,
      userDisplayName: users.displayName,
      createdAt: sshKeys.createdAt,
    })
    .from(sshKeys)
    .innerJoin(users, eq(sshKeys.userId, users.id))
    .where(eq(sshKeys.organizationId, organizationId))
    .orderBy(sshKeys.createdAt);

  const keys = await Promise.all(
    rows.map(async (row) => {
      const publicKey = await decrypt(row.encryptedPublicKey, row.publicKeyIv);
      return {
        id: row.id,
        name: row.name,
        keyType: row.keyType,
        publicKey,
        userId: row.userId,
        ownerEmail: row.userEmail,
        ownerName: row.userDisplayName ?? row.userEmail,
        createdAt: row.createdAt.toISOString(),
      };
    }),
  );

  return c.json(keys);
});

/**
 * POST /api/ssh-keys — generate a new Ed25519 keypair.
 * The server generates the keypair, stores both encrypted, and returns the
 * public key + private key to the caller (private key is only returned once).
 */
app.post("/", async (c) => {
  const organizationId = c.get("organizationId");
  const { userId } = c.get("session");
  const { name } = await c.req.json<{ name: string }>();

  if (!name?.trim()) return c.json({ error: "Name is required" }, 400);

  // Generate Ed25519 keypair
  const { publicKey: pubPem, privateKey: privPem } = await generateKeyPair("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  // Extract raw key bytes from DER encodings
  const spkiDer = crypto.createPublicKey(pubPem).export({ type: "spki", format: "der" });
  const pkcs8Der = crypto.createPrivateKey(privPem).export({ type: "pkcs8", format: "der" });
  const rawPubKey = spkiDer.subarray(12);        // 32 bytes after SPKI header
  const rawPrivKey = pkcs8Der.subarray(16);       // 32 bytes after PKCS#8 header

  // Build OpenSSH public key wire format
  const sshPublicKey = `ssh-ed25519 ${sshWireString("ssh-ed25519", rawPubKey).toString("base64")} ${name.trim()}`;

  // Build OpenSSH private key format (same as ssh-keygen output)
  const privateKeyOpenSsh = buildOpenSshPrivateKey(rawPrivKey, rawPubKey, name.trim());

  // Encrypt both keys at rest
  const encPub = await encrypt(sshPublicKey);
  const encPriv = await encrypt(privateKeyOpenSsh);

  const id = crypto.randomUUID();

  await db.insert(sshKeys).values({
    id,
    organizationId,
    userId,
    name: name.trim(),
    encryptedPublicKey: encPub.ciphertext,
    publicKeyIv: encPub.iv,
    encryptedPrivateKey: encPriv.ciphertext,
    privateKeyIv: encPriv.iv,
    keyType: "ssh-ed25519",
  });

  return c.json({
    id,
    name: name.trim(),
    keyType: "ssh-ed25519",
    publicKey: sshPublicKey,
    privateKey: privateKeyOpenSsh,
  });
});

/** DELETE /api/ssh-keys/:id — delete a key (only the owner can delete their own) */
app.delete("/:id", async (c) => {
  const organizationId = c.get("organizationId");
  const { userId } = c.get("session");
  const id = c.req.param("id");

  const result = await db
    .delete(sshKeys)
    .where(
      and(
        eq(sshKeys.id, id),
        eq(sshKeys.organizationId, organizationId),
        eq(sshKeys.userId, userId),
      ),
    );

  return c.json({ ok: true });
});

export { app as sshKeyRoutes };
