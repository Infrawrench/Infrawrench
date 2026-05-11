import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { db } from "../../db/client";
import { sshKeys, users } from "../../db/schema";
import { encrypt, decrypt, buildAad } from "../../services/encryption";
import { requirePermission } from "../../auth/permissions";
import { hasPermission } from "@infrawrench/server-core/permissions";
import type { AuthSession } from "../auth-middleware";

const generateKeyPair = promisify(crypto.generateKeyPair);

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

// Length-prefixed SSH wire string: uint32be(len) + data.
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

// Unencrypted OpenSSH private key file, matching `ssh-keygen -t ed25519`.
// Spec: https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.key
function buildOpenSshPrivateKey(privSeed: Buffer, pubKey: Buffer, comment: string): string {
  const AUTH_MAGIC = "openssh-key-v1\0";
  const cipherName = "none";
  const kdfName = "none";
  const kdfOptions = Buffer.alloc(0);
  const keyCount = 1;

  const pubBlob = sshWireString("ssh-ed25519", pubKey);

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

  // The OpenSSH format repeats the checkint to detect bad decryption.
  const privSection = Buffer.concat([
    checkInt,
    checkInt,
    keyTypeLenBuf,
    keyType,
    pubLenBuf,
    pubKey,
    fullPrivLenBuf,
    fullPriv,
    commentLenBuf,
    commentBuf,
  ]);

  // Pad to 8-byte boundary (cipher block size for "none").
  const padLen = 8 - (privSection.length % 8);
  const padding = Buffer.alloc(padLen === 8 ? 0 : padLen);
  for (let i = 0; i < padding.length; i++) padding[i] = i + 1;
  const paddedPriv = Buffer.concat([privSection, padding]);

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
    cipherLenBuf,
    cipherBuf,
    kdfLenBuf,
    kdfBuf,
    kdfOptLenBuf,
    kdfOptions,
    keyCountBuf,
    pubBlobLenBuf,
    pubBlob,
    privLenBuf,
    paddedPriv,
  ]);

  const b64 = full.toString("base64");
  const lines = b64.match(/.{1,70}/g) ?? [];
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

const app = new Hono();

function computeFingerprint(publicKey: string): string {
  const parts = publicKey.trim().split(/\s+/);
  if (parts.length < 2) throw new Error("Invalid SSH public key format");
  const blob = Buffer.from(parts[1]!, "base64");
  const hash = crypto.createHash("sha256").update(blob).digest("base64");
  // Strip trailing '=' to match ssh-keygen's output.
  return `SHA256:${hash.replace(/=+$/, "")}`;
}

function validateSshPublicKey(key: string): { keyType: string; publicKey: string } {
  const trimmed = key.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) throw new Error("Invalid SSH public key format");

  const keyType = parts[0]!;
  const validTypes = [
    "ssh-rsa",
    "ssh-ed25519",
    "ssh-dss",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "sk-ssh-ed25519@openssh.com",
    "sk-ecdsa-sha2-nistp256@openssh.com",
  ];
  if (!validTypes.includes(keyType)) {
    throw new Error(`Unsupported key type: ${keyType}`);
  }

  const blob = Buffer.from(parts[1]!, "base64");
  if (blob.length < 16) throw new Error("SSH public key blob is too short");

  // The type embedded in the blob must match the outer prefix.
  const typeLen = blob.readUInt32BE(0);
  const embeddedType = blob.subarray(4, 4 + typeLen).toString("utf8");
  if (embeddedType !== keyType) {
    throw new Error("SSH public key type mismatch");
  }

  return { keyType, publicKey: trimmed };
}

app.get("/", async (c) => {
  requirePermission(c, "ssh-keys:read");
  const organizationId = c.get("organizationId");
  const rows = await db
    .select({
      id: sshKeys.id,
      name: sshKeys.name,
      keyType: sshKeys.keyType,
      isImported: sshKeys.isImported,
      fingerprint: sshKeys.fingerprint,
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
      const publicKey = await decrypt(
        row.encryptedPublicKey,
        row.publicKeyIv,
        buildAad("sshKey", row.id, "publicKey"),
      );
      return {
        id: row.id,
        name: row.name,
        keyType: row.keyType,
        isImported: row.isImported,
        fingerprint: row.fingerprint,
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

// Generates an Ed25519 keypair; the private key is returned to the caller exactly once.
app.post("/", async (c) => {
  requirePermission(c, "ssh-keys:write");
  const organizationId = c.get("organizationId");
  const { userId } = c.get("session");
  const { name } = await c.req.json<{ name: string }>();

  if (!name?.trim()) return c.json({ error: "Name is required" }, 400);

  const { publicKey: pubPem, privateKey: privPem } = await generateKeyPair("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const spkiDer = crypto.createPublicKey(pubPem).export({ type: "spki", format: "der" });
  const pkcs8Der = crypto.createPrivateKey(privPem).export({ type: "pkcs8", format: "der" });
  const rawPubKey = spkiDer.subarray(12); // 32 bytes after SPKI header
  const rawPrivKey = pkcs8Der.subarray(16); // 32 bytes after PKCS#8 header

  const sshPublicKey = `ssh-ed25519 ${sshWireString("ssh-ed25519", rawPubKey).toString("base64")} ${name.trim()}`;
  const privateKeyOpenSsh = buildOpenSshPrivateKey(rawPrivKey, rawPubKey, name.trim());

  const id = crypto.randomUUID();
  const fingerprint = computeFingerprint(sshPublicKey);

  // AAD binds the ciphertext to this row id.
  const encPub = await encrypt(sshPublicKey, buildAad("sshKey", id, "publicKey"));
  const encPriv = await encrypt(privateKeyOpenSsh, buildAad("sshKey", id, "privateKey"));

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
    isImported: false,
    fingerprint,
  });

  return c.json({
    id,
    name: name.trim(),
    keyType: "ssh-ed25519",
    fingerprint,
    publicKey: sshPublicKey,
    privateKey: privateKeyOpenSsh,
  });
});

// Stores only the public key; the user retains the private key.
app.post("/import", async (c) => {
  requirePermission(c, "ssh-keys:write");
  const organizationId = c.get("organizationId");
  const { userId } = c.get("session");
  const { name, publicKey: rawPublicKey } = await c.req.json<{
    name: string;
    publicKey: string;
  }>();

  if (!name?.trim()) return c.json({ error: "Name is required" }, 400);
  if (!rawPublicKey?.trim()) return c.json({ error: "Public key is required" }, 400);

  let keyType: string;
  let publicKey: string;
  try {
    const result = validateSshPublicKey(rawPublicKey);
    keyType = result.keyType;
    publicKey = result.publicKey;
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Invalid SSH public key" }, 400);
  }

  const fingerprint = computeFingerprint(publicKey);

  const id = crypto.randomUUID();
  const encPub = await encrypt(publicKey, buildAad("sshKey", id, "publicKey"));

  await db.insert(sshKeys).values({
    id,
    organizationId,
    userId,
    name: name.trim(),
    encryptedPublicKey: encPub.ciphertext,
    publicKeyIv: encPub.iv,
    keyType,
    isImported: true,
    fingerprint,
  });

  return c.json({
    id,
    name: name.trim(),
    keyType,
    fingerprint,
    publicKey,
    isImported: true,
  });
});

// Owners may delete their own keys; team:role:write may delete any key in the
// org (offboarding, revoking compromised keys). 404 covers wrong id, wrong
// org, or a non-admin targeting someone else's key.
app.delete("/:id", async (c) => {
  requirePermission(c, "ssh-keys:write");
  const organizationId = c.get("organizationId");
  const { userId } = c.get("session");
  const id = c.req.param("id");

  const grantedPerms = c.get("permissions") ?? [];
  const canManageAll = hasPermission(grantedPerms, "team:role:write");

  const whereClause = canManageAll
    ? and(eq(sshKeys.id, id), eq(sshKeys.organizationId, organizationId))
    : and(
        eq(sshKeys.id, id),
        eq(sshKeys.organizationId, organizationId),
        eq(sshKeys.userId, userId),
      );

  const result = await db.delete(sshKeys).where(whereClause).returning({ id: sshKeys.id });

  if (result.length === 0) {
    return c.json({ error: "SSH key not found" }, 404);
  }
  return c.json({ ok: true });
});

export { app as sshKeyRoutes };
