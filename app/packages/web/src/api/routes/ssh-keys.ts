import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import crypto from "node:crypto";
import {
  computeSshPublicKeyFingerprint,
  generateEd25519OpenSshKeyPair,
} from "@infrawrench/ssh-tunnel-core";
import { db } from "../../db/client";
import { sshKeys, users } from "../../db/schema";
import { encrypt, decrypt, buildAad } from "../../services/encryption";
import { validateSshPublicKey } from "../../services/ssh-keys";
import { requirePermission } from "../../auth/permissions";
import { hasPermission } from "@infrawrench/server-core/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

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

  const { publicKey: sshPublicKey, privateKey: privateKeyOpenSsh } =
    await generateEd25519OpenSshKeyPair(name.trim());

  const id = crypto.randomUUID();
  const fingerprint = computeSshPublicKeyFingerprint(sshPublicKey);

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

  const fingerprint = computeSshPublicKeyFingerprint(publicKey);

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
