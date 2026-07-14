/**
 * Resolve an org account row into an instantiated plugin client. Shared by
 * the workflow runner (server-core/poller) and the cloud web host, which
 * previously kept identical copies of this function.
 */
import { and, eq } from "drizzle-orm";

import { db } from "./db/client";
import { accounts } from "./db/schema";
import { decrypt, buildAad } from "./encryption";
import { getPlugin } from "./plugin-loader";
import { buildPluginHostServices } from "./host-services";
import { applyCredentialRewriters } from "./credential-rewriters";

/** Decrypt an account's credentials and instantiate its plugin client. */
export async function getOrgAccountClient(accountId: string, organizationId: string) {
  const [account] = await db
    .select({
      id: accounts.id,
      pluginId: accounts.pluginId,
      encryptedCredentials: accounts.encryptedCredentials,
      credentialsIv: accounts.credentialsIv,
      bastionId: accounts.bastionId,
    })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)))
    .limit(1);
  if (!account) return null;

  const plaintext = await decrypt(
    account.encryptedCredentials,
    account.credentialsIv,
    buildAad("account", account.id, "credentials"),
  );
  const credentials = JSON.parse(plaintext) as Record<string, string>;

  await applyCredentialRewriters({ orgId: organizationId, accountId }, credentials);

  const loaded = await getPlugin(account.pluginId);
  if (!loaded) return null;

  const hostServices = await buildPluginHostServices(loaded.plugin.manifest, credentials, {
    accountId,
    bastionId: account.bastionId ?? null,
  });
  const client = loaded.plugin.createClient(credentials, hostServices);
  return { client, plugin: loaded.plugin, credentials, account };
}
