/**
 * Resolves SSH-key references in workflow `create()`/`update()` fields.
 *
 * The dts suggests the org's Infrawrench SSH key NAMES for `ssh-key-picker`
 * fields, but providers (e.g. DigitalOcean's droplet `sshPublicKey`) expect the
 * raw OpenSSH public-key string. This resolver — wired in as the workflow host's
 * `transformCreateFields` — rewrites any `ssh-key-picker` field whose value is a
 * known key name/id into that key's public key. A value that is already a public
 * key is passed through untouched (so authors can paste one directly).
 *
 * Shared by the cloud web host and the poller.
 */
import type { PluginClient } from "@infrawrench/plugin-base";
import { and, eq, or } from "drizzle-orm";

import { db } from "../db/client";
import { sshKeys } from "../db/schema";
import { decrypt, buildAad } from "../encryption";
import { getCreateFieldsForType } from "./create-fields-cache";

/** A value that already looks like an OpenSSH public key — leave it alone. */
const PUBLIC_KEY_RE = /^(ssh-|ecdsa-|sk-ssh-|sk-ecdsa-)/;

/** Distinct names of the org's Infrawrench-managed SSH keys (for dts autocomplete). */
export async function listOrgSshKeyNames(organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ name: sshKeys.name })
    .from(sshKeys)
    .where(eq(sshKeys.organizationId, organizationId));
  return Array.from(new Set(rows.map((r) => r.name))).sort();
}

/** Decrypt the public key for an org SSH key referenced by id or name. */
async function getOrgSshPublicKey(
  organizationId: string,
  nameOrId: string,
): Promise<string | null> {
  const [row] = await db
    .select({
      id: sshKeys.id,
      encryptedPublicKey: sshKeys.encryptedPublicKey,
      publicKeyIv: sshKeys.publicKeyIv,
    })
    .from(sshKeys)
    .where(
      and(
        eq(sshKeys.organizationId, organizationId),
        or(eq(sshKeys.id, nameOrId), eq(sshKeys.name, nameOrId)),
      ),
    )
    .limit(1);
  if (!row) return null;
  return decrypt(row.encryptedPublicKey, row.publicKeyIv, buildAad("sshKey", row.id, "publicKey"));
}

/**
 * Build a `transformCreateFields(accountId, typeId, fields)` for the org. Needs
 * a way to resolve an account's plugin id + client (to find which fields are
 * `ssh-key-picker`).
 */
export function buildSshKeyFieldResolver(
  organizationId: string,
  getAccountClient: (
    accountId: string,
  ) => Promise<{ client: PluginClient; pluginId: string } | null>,
) {
  return async (
    accountId: string,
    typeId: string,
    fields: Record<string, string>,
  ): Promise<{ fields: Record<string, string>; sshKeyRef?: string }> => {
    const ctx = await getAccountClient(accountId).catch(() => null);
    if (!ctx) return { fields };

    const createFields = await getCreateFieldsForType(ctx.pluginId, typeId, async () => ctx.client);
    const sshFieldKeys = (createFields ?? [])
      .filter((f) => f.kind === "ssh-key-picker")
      .map((f) => f.key);
    if (sshFieldKeys.length === 0) return { fields };

    const out = { ...fields };
    let sshKeyRef: string | undefined;
    for (const key of sshFieldKeys) {
      const value = out[key]?.trim();
      // Skip empties and values that are already a public key.
      if (!value || PUBLIC_KEY_RE.test(value)) continue;
      const pub = await getOrgSshPublicKey(organizationId, value);
      if (pub) {
        out[key] = pub.trim();
        // Remember the key NAME so the created resource can ssh() with it.
        if (!sshKeyRef) sshKeyRef = value;
      }
    }
    return { fields: out, ...(sshKeyRef ? { sshKeyRef } : {}) };
  };
}
