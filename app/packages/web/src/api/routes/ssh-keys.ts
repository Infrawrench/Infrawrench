import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import crypto from "node:crypto";
import {
  computeSshPublicKeyFingerprint,
  generateEd25519OpenSshKeyPair,
  isSshSignAlgorithm,
  signSshData,
} from "@infrawrench/ssh-tunnel-core";
import { db } from "../../db/client";
import { sshKeys, users } from "../../db/schema";
import { encrypt, decrypt, buildAad } from "../../services/encryption";
import { validateSshPublicKey } from "../../services/ssh-keys";
import { requirePermission } from "../../auth/permissions";
import { hasPermission } from "@infrawrench/server-core/permissions";
import { logAudit } from "../../services/audit";
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

// A userauth blob is a session id plus the request fields — a few hundred
// bytes. The cap only exists so the endpoint cannot be fed arbitrary payloads.
const MAX_SIGN_DATA_BYTES = 16 * 1024;

// The cloud acting as an SSH agent: sign one publickey-auth challenge with an
// org key whose private half never leaves the server. The desktop app uses
// this to open its *own* SSH connection with a cloud key (Linux apps stream
// directly from the host instead of hairpinning through the cloud); the key
// material moves nothing, only signatures do.
//
// Deliberately gated on `resources:execute`, not `ssh-keys:read` — producing
// an auth signature is the same authority as opening a shell, exactly as the
// `/api/ws` and `/api/apps` proxies are gated. Every call is audited.
app.post("/:id/sign", async (c) => {
  requirePermission(c, "resources:execute");
  const organizationId = c.get("organizationId");
  const { userId } = c.get("session");
  const id = c.req.param("id");
  const { data, algorithm, context } = await c.req.json<{
    data?: string;
    algorithm?: string;
    context?: { host?: string; username?: string };
  }>();

  const auditBase = {
    organizationId,
    userId,
    entityType: "ssh-key",
    entityId: id,
  };
  const auditMeta = {
    sshKeyId: id,
    source: "remote-agent",
    ...(typeof context?.host === "string" ? { sshHost: context.host.slice(0, 256) } : {}),
    ...(typeof context?.username === "string"
      ? { sshUsername: context.username.slice(0, 256) }
      : {}),
  };
  const refuse = (status: 400 | 404, error: string, failureReason: string) => {
    void logAudit({
      ...auditBase,
      action: "ssh.agent.sign_failed",
      metadata: { ...auditMeta, failureReason },
    });
    return c.json({ error }, status);
  };

  if (!data || typeof data !== "string") {
    return refuse(400, "data (base64) is required", "missing_data");
  }
  if (!algorithm || !isSshSignAlgorithm(algorithm)) {
    return refuse(400, "algorithm must be an SSH signature format identifier", "bad_algorithm");
  }
  const payload = Buffer.from(data, "base64");
  if (payload.length === 0 || payload.length > MAX_SIGN_DATA_BYTES) {
    return refuse(400, "data must decode to between 1 byte and 16 KiB", "bad_data_size");
  }

  const [key] = await db
    .select()
    .from(sshKeys)
    .where(and(eq(sshKeys.id, id), eq(sshKeys.organizationId, organizationId)));
  if (!key) return refuse(404, "SSH key not found", "not_found");
  if (!key.encryptedPrivateKey || !key.privateKeyIv) {
    return refuse(
      400,
      "This key was imported — its private half is not held by Infrawrench Cloud, so the cloud cannot sign with it",
      "no_private_key",
    );
  }

  const privateKey = await decrypt(
    key.encryptedPrivateKey,
    key.privateKeyIv,
    buildAad("sshKey", key.id, "privateKey"),
  );

  let signature: Buffer;
  try {
    signature = signSshData(privateKey, payload, algorithm);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Signing failed";
    return refuse(400, message, `sign_error:${message}`);
  }

  void logAudit({
    ...auditBase,
    action: "ssh.agent.sign",
    metadata: { ...auditMeta, keyType: key.keyType, signatureFormat: algorithm },
  });

  return c.json({ signature: signature.toString("base64"), algorithm });
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
