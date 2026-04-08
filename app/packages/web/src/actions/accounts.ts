"use server";

import { v4 as uuid } from "uuid";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts } from "@/db/schema";
import { encrypt, decrypt } from "@/services/encryption";
import { requireAuth } from "@/auth/session";
import { loadPlugins, getPlugin } from "@/plugins/loader";
import { syncResources } from "./resources";

export interface AccountSummary {
  id: string;
  pluginId: string;
  displayName: string;
  createdAt: Date;
}

export interface PluginCredentialField {
  key: string;
  label: string;
  description: string | undefined;
  placeholder: string | undefined;
  sensitive: boolean;
  multiline: boolean | undefined;
  defaultValue: string | undefined;
}

export interface PluginInfo {
  id: string;
  displayName: string;
  logoSvg: string;
  credentialFields: PluginCredentialField[];
}

export async function listPlugins(): Promise<PluginInfo[]> {
  const plugins = await loadPlugins();
  return plugins.map((p) => ({
    id: p.plugin.manifest.id,
    displayName: p.plugin.manifest.displayName,
    logoSvg: p.plugin.manifest.logoSvg,
    credentialFields: p.plugin.manifest.credentialFields.map((f) => ({
      key: f.key,
      label: f.label,
      description: f.description,
      placeholder: f.placeholder,
      sensitive: f.sensitive,
      multiline: f.multiline,
      defaultValue: f.defaultValue,
    })),
  }));
}

export async function listAccounts(): Promise<AccountSummary[]> {
  const session = await requireAuth();
  const rows = await db
    .select({
      id: accounts.id,
      pluginId: accounts.pluginId,
      displayName: accounts.displayName,
      createdAt: accounts.createdAt,
    })
    .from(accounts)
    .where(and(eq(accounts.organizationId, session.organizationId), isNull(accounts.deletedAt)));
  return rows;
}

export async function createAccount(input: {
  pluginId: string;
  displayName: string;
  credentials: Record<string, string>;
}): Promise<{ id: string }> {
  const session = await requireAuth();
  const { ciphertext, iv } = await encrypt(JSON.stringify(input.credentials));
  const id = uuid();
  await db.insert(accounts).values({
    id,
    organizationId: session.organizationId,
    pluginId: input.pluginId,
    displayName: input.displayName,
    encryptedCredentials: ciphertext,
    credentialsIv: iv,
  });

  // Fire-and-forget: sync resources immediately so they appear without manual expand
  void syncResources(id).catch((e) =>
    console.error(`[createAccount] Background sync failed for ${id}:`, e),
  );

  return { id };
}

export async function deleteAccount(accountId: string): Promise<void> {
  const session = await requireAuth();
  await db
    .delete(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, session.organizationId)));
}

export async function getDecryptedCredentials(accountId: string): Promise<Record<string, string>> {
  const session = await requireAuth();
  const [row] = await db
    .select({
      encryptedCredentials: accounts.encryptedCredentials,
      credentialsIv: accounts.credentialsIv,
    })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, session.organizationId)));
  if (!row) throw new Error("Account not found");
  const plaintext = await decrypt(row.encryptedCredentials, row.credentialsIv);
  return JSON.parse(plaintext) as Record<string, string>;
}
