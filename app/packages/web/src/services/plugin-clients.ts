import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { accounts, resources } from "../db/schema";
import { decrypt } from "./encryption";
import { getPlugin } from "../plugins/loader";
import { buildPluginHostServices } from "./host-services";
import { rewriteCredentialsThroughTunnel } from "./tunnel-resolver";

export async function getClientForAccount(accountId: string, organizationId: string) {
  const [account] = await db
    .select({
      id: accounts.id,
      pluginId: accounts.pluginId,
      encryptedCredentials: accounts.encryptedCredentials,
      credentialsIv: accounts.credentialsIv,
    })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)))
    .limit(1);

  if (!account) return null;

  const plaintext = await decrypt(account.encryptedCredentials, account.credentialsIv);
  const credentials = JSON.parse(plaintext) as Record<string, string>;

  await rewriteCredentialsThroughTunnel(accountId, credentials);

  const loaded = await getPlugin(account.pluginId);
  if (!loaded) return null;

  const hostServices = buildPluginHostServices(loaded.plugin.manifest, credentials);
  const client = loaded.plugin.createClient(credentials, hostServices);
  return { client, plugin: loaded.plugin, credentials, account };
}

/**
 * Resolves a plugin client for a peer resource. When `pluginId` matches the
 * account's native plugin, returns the account's client directly. When it
 * differs (e.g. redis-instance on a google-cloud account), resolves peer
 * credentials through the parent resource and builds the peer plugin's client.
 */
export async function getClientForResource(
  pluginId: string,
  accountId: string,
  organizationId: string,
  parentResourceId?: string,
) {
  const parent = await getClientForAccount(accountId, organizationId);
  if (!parent) return null;
  if (parent.account.pluginId === pluginId) return parent;

  if (!parentResourceId) return null;

  const [parentResource] = await db
    .select({ resourceTypeId: resources.resourceTypeId })
    .from(resources)
    .where(
      and(
        eq(resources.id, parentResourceId),
        eq(resources.organizationId, organizationId),
        isNull(resources.deletedAt),
      ),
    )
    .limit(1);
  if (!parentResource) return null;

  const parentResourceTypeDef = parent.plugin.resourceTypes.find(
    (t) => t.id === parentResource.resourceTypeId,
  );
  const integration = parentResourceTypeDef?.peerIntegrations?.find((i) => i.pluginId === pluginId);
  if (!integration) return null;

  const peerCredentials: Record<string, string> = {};
  for (const mapping of integration.credentialMappings) {
    const value = await parent.client.resolveOutput(
      parentResource.resourceTypeId,
      parentResourceId,
      mapping.outputKey,
      accountId,
    );
    peerCredentials[mapping.credentialKey] = value;
  }

  const peerLoaded = await getPlugin(pluginId);
  if (!peerLoaded) return null;

  const peerHostServices = buildPluginHostServices(peerLoaded.plugin.manifest, peerCredentials);
  const peerClient = peerLoaded.plugin.createClient(peerCredentials, peerHostServices);
  return {
    client: peerClient,
    plugin: peerLoaded.plugin,
    credentials: peerCredentials,
    account: parent.account,
  };
}
