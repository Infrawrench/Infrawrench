/**
 * Resolve a stored org SSH key (Settings → SSH keys) to its public key text.
 * Used by the create tools so the model can reference a key by id instead of
 * pasting public key material — only the PUBLIC key ever leaves the store.
 */
import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { sshKeys } from "../db/schema";
import { decrypt, buildAad } from "../services/encryption";

export async function resolveStoredSshPublicKey(
  organizationId: string,
  sshKeyId: string,
): Promise<string | null> {
  const [row] = await db
    .select({
      id: sshKeys.id,
      encryptedPublicKey: sshKeys.encryptedPublicKey,
      publicKeyIv: sshKeys.publicKeyIv,
    })
    .from(sshKeys)
    .where(and(eq(sshKeys.id, sshKeyId), eq(sshKeys.organizationId, organizationId)))
    .limit(1);
  if (!row) return null;
  return decrypt(row.encryptedPublicKey, row.publicKeyIv, buildAad("sshKey", row.id, "publicKey"));
}
