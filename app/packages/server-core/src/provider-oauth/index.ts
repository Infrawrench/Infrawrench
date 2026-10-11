/**
 * Provider OAuth ("Connect with X") on the server: client configuration,
 * sealed state and grants, credential acceptance and token refresh. See
 * `plugin-base/src/oauth.ts` for the shared contract.
 */
import { readOAuthGrantState, type PluginManifest } from "@infrawrench/plugin-base";

import { buildAad, decrypt } from "../encryption";
import { resolveOAuthCredentials } from "./refresh";

export * from "./config";
export * from "./seal";
export * from "./credentials";
export * from "./refresh";

/**
 * Decrypt an account row's credentials and, when they carry an expiring
 * OAuth grant, refresh them first. The shared entry point for every server
 * site that builds a plugin client or hands credentials back.
 */
export async function decryptAccountCredentials(
  account: {
    id: string;
    organizationId: string;
    encryptedCredentials: string;
    credentialsIv: string;
  },
  manifest: PluginManifest | undefined,
): Promise<Record<string, string>> {
  const credentials = JSON.parse(
    await decrypt(
      account.encryptedCredentials,
      account.credentialsIv,
      buildAad("account", account.id, "credentials"),
    ),
  ) as Record<string, string>;
  if (!manifest || !readOAuthGrantState(credentials)) return credentials;
  return resolveOAuthCredentials({
    accountId: account.id,
    organizationId: account.organizationId,
    manifest,
    credentials,
  });
}
