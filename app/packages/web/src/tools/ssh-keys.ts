/**
 * SSH key tools — expose the org SSH key store (Settings → SSH keys) to MCP
 * clients and the chat agent, with the same permission model as the HTTP API:
 * `ssh-keys:read` / `ssh-keys:write`, and `team:role:write` extending deletion
 * to other members' keys.
 *
 * Private keys never leave the server through these tools. A generated key is
 * stored encrypted and usable by id with `ssh_exec` and SSH tunnels; the
 * one-time private-key download only exists in the Settings UI.
 */
import crypto from "node:crypto";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import {
  computeSshPublicKeyFingerprint,
  generateEd25519OpenSshKeyPair,
} from "@infrawrench/ssh-tunnel-core";
import { resolveEffectivePermissions } from "@infrawrench/server-core/permissions";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { db } from "../db/client";
import { sshKeys, users } from "../db/schema";
import { encrypt, decrypt, buildAad } from "../services/encryption";
import { validateSshPublicKey } from "../services/ssh-keys";
import { logAudit } from "../services/audit";
import { denyUnlessPermitted } from "./permissions";
import { ok, err, type ToolDefinition } from "./types";

export function sshKeyTools(): ToolDefinition[] {
  return [
    {
      name: "list_ssh_keys",
      title: "List SSH keys",
      description:
        "List the organization's SSH keys: id, name, key type, fingerprint, public key, owner, " +
        "and whether the key was imported (public key only) or generated (private key stored " +
        "encrypted server-side). Use the id with ssh_exec or SSH tunnels.",
      inputSchema: {},
      risk: "read",
      handler: async (_input, auth) => {
        const denied = await denyUnlessPermitted(auth, "ssh-keys:read");
        if (denied) return denied;

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
            createdAt: sshKeys.createdAt,
          })
          .from(sshKeys)
          .innerJoin(users, eq(sshKeys.userId, users.id))
          .where(eq(sshKeys.organizationId, auth.organizationId))
          .orderBy(sshKeys.createdAt);

        const keys = await Promise.all(
          rows.map(async (row) => ({
            id: row.id,
            name: row.name,
            keyType: row.keyType,
            isImported: row.isImported,
            fingerprint: row.fingerprint,
            publicKey: await decrypt(
              row.encryptedPublicKey,
              row.publicKeyIv,
              buildAad("sshKey", row.id, "publicKey"),
            ),
            ownerUserId: row.userId,
            ownerEmail: row.userEmail,
            createdAt: row.createdAt.toISOString(),
          })),
        );
        return ok(keys);
      },
    },

    {
      name: "create_ssh_key",
      title: "Generate SSH key",
      description:
        "Generate a new Ed25519 SSH keypair for the organization. The private key is stored " +
        "encrypted server-side and is usable by id with ssh_exec and SSH tunnels — it is NOT " +
        "returned by this tool. If the user needs to download the private key for use outside " +
        "Infrawrench, they must generate the key in Settings → SSH keys instead. Returns the " +
        "public key (safe to install on remote hosts' authorized_keys).",
      inputSchema: {
        name: z.string().min(1).describe("Display name for the key"),
      },
      risk: "write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "ssh-keys:write");
        if (denied) return denied;
        const name = String(input["name"] ?? "").trim();
        if (!name) return err("Name is required");

        const { publicKey, privateKey } = await generateEd25519OpenSshKeyPair(name);
        const id = crypto.randomUUID();
        const fingerprint = computeSshPublicKeyFingerprint(publicKey);
        const encPub = await encrypt(publicKey, buildAad("sshKey", id, "publicKey"));
        const encPriv = await encrypt(privateKey, buildAad("sshKey", id, "privateKey"));

        await db.insert(sshKeys).values({
          id,
          organizationId: auth.organizationId,
          userId: auth.userId,
          name,
          encryptedPublicKey: encPub.ciphertext,
          publicKeyIv: encPub.iv,
          encryptedPrivateKey: encPriv.ciphertext,
          privateKeyIv: encPriv.iv,
          keyType: "ssh-ed25519",
          isImported: false,
          fingerprint,
        });

        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          apiKeyId: auth.apiKeyId,
          action: "ssh-key.create",
          entityType: "sshKey",
          entityId: id,
          metadata: { name, fingerprint, source: auth.source, tool: "create_ssh_key" },
        });

        return ok({
          id,
          name,
          keyType: "ssh-ed25519",
          fingerprint,
          publicKey,
          note:
            "Private key stored encrypted server-side; use this key id with ssh_exec or SSH " +
            "tunnels. To download a private key, generate a key in Settings → SSH keys instead.",
        });
      },
    },

    {
      name: "import_ssh_key",
      title: "Import SSH public key",
      description:
        "Import an existing SSH public key (the user keeps the private key). Accepts OpenSSH " +
        'format ("ssh-ed25519 AAAA… comment"). Imported keys can be installed on hosts but ' +
        "cannot be used by ssh_exec or tunnels (the server has no private key for them).",
      inputSchema: {
        name: z.string().min(1).describe("Display name for the key"),
        publicKey: z.string().min(1).describe("OpenSSH-format public key"),
      },
      risk: "write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "ssh-keys:write");
        if (denied) return denied;
        const name = String(input["name"] ?? "").trim();
        if (!name) return err("Name is required");

        let keyType: string;
        let publicKey: string;
        try {
          const result = validateSshPublicKey(String(input["publicKey"] ?? ""));
          keyType = result.keyType;
          publicKey = result.publicKey;
        } catch (e) {
          return err(e instanceof Error ? e.message : "Invalid SSH public key");
        }

        const id = crypto.randomUUID();
        const fingerprint = computeSshPublicKeyFingerprint(publicKey);
        const encPub = await encrypt(publicKey, buildAad("sshKey", id, "publicKey"));

        await db.insert(sshKeys).values({
          id,
          organizationId: auth.organizationId,
          userId: auth.userId,
          name,
          encryptedPublicKey: encPub.ciphertext,
          publicKeyIv: encPub.iv,
          keyType,
          isImported: true,
          fingerprint,
        });

        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          apiKeyId: auth.apiKeyId,
          action: "ssh-key.import",
          entityType: "sshKey",
          entityId: id,
          metadata: { name, fingerprint, keyType, source: auth.source, tool: "import_ssh_key" },
        });

        return ok({ id, name, keyType, fingerprint, publicKey, isImported: true });
      },
    },

    {
      name: "delete_ssh_key",
      title: "Delete SSH key",
      description:
        "Delete an SSH key from the organization. Users can delete their own keys; deleting " +
        "another member's key additionally requires the team:role:write permission (offboarding, " +
        "revoking a compromised key). Irreversible.",
      inputSchema: {
        sshKeyId: z.string().describe("Key id (see list_ssh_keys)"),
      },
      risk: "destructive",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "ssh-keys:write");
        if (denied) return denied;
        const sshKeyId = String(input["sshKeyId"] ?? "");
        if (!sshKeyId) return err("sshKeyId is required");

        const access = await resolveEffectivePermissions(auth.organizationId, {
          kind: "user",
          userId: auth.userId,
        });
        const canManageAll = hasPermission(access.permissions, "team:role:write");

        const whereClause = canManageAll
          ? and(eq(sshKeys.id, sshKeyId), eq(sshKeys.organizationId, auth.organizationId))
          : and(
              eq(sshKeys.id, sshKeyId),
              eq(sshKeys.organizationId, auth.organizationId),
              eq(sshKeys.userId, auth.userId),
            );

        const result = await db.delete(sshKeys).where(whereClause).returning({ id: sshKeys.id });
        if (result.length === 0) {
          return err(
            "SSH key not found — wrong id, or it belongs to another member and you lack team:role:write",
          );
        }

        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          apiKeyId: auth.apiKeyId,
          action: "ssh-key.delete",
          entityType: "sshKey",
          entityId: sshKeyId,
          metadata: { source: auth.source, tool: "delete_ssh_key" },
        });

        return ok({ deleted: sshKeyId });
      },
    },
  ];
}
