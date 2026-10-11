/**
 * Resolve an org account row into an instantiated plugin client. Shared by
 * the workflow runner (server-core/poller) and the cloud web host.
 */
import { and, eq } from "drizzle-orm";

import { db } from "./db/client";
import { accounts } from "./db/schema";
import { decryptAccountCredentials } from "./provider-oauth";
import { getPlugin } from "./plugin-loader";
import { buildPluginHostServices } from "./host-services";
import { withEgressScope } from "./egress-guard";
import { applyCredentialRewriters } from "./credential-rewriters";

/** Decrypt an account's credentials and instantiate its plugin client. */
export async function getOrgAccountClient(accountId: string, organizationId: string) {
  const [account] = await db
    .select({
      id: accounts.id,
      organizationId: accounts.organizationId,
      pluginId: accounts.pluginId,
      encryptedCredentials: accounts.encryptedCredentials,
      credentialsIv: accounts.credentialsIv,
      bastionId: accounts.bastionId,
    })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)))
    .limit(1);
  if (!account) return null;

  const loaded = await getPlugin(account.pluginId);
  if (!loaded) return null;

  // Refreshes an expiring OAuth access token (and persists the rotation)
  // before anything reads the credentials.
  const credentials = await decryptAccountCredentials(account, loaded.plugin.manifest);

  await applyCredentialRewriters({ orgId: organizationId, accountId }, credentials);

  const hostServices = await buildPluginHostServices(loaded.plugin.manifest, credentials, {
    accountId,
    organizationId,
    bastionId: account.bastionId ?? null,
  });
  const client = withEgressScope(loaded.plugin.createClient(credentials, hostServices), {
    accountId,
    organizationId,
  });
  return { client, plugin: loaded.plugin, credentials, account };
}
