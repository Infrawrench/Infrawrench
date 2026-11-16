import { getPlugin } from "../plugins/loader";
import { buildPluginHostServices } from "./sql-drivers";
import type { HostPluginClient } from "@infrawrench/plugin-base";
import { applyCredentialRewriters } from "./credential-rewriters";
import { getLocalConnectionCredentials } from "./local-credentials";

export async function createPluginClient(
  accountId: string,
  pluginId: string,
): Promise<HostPluginClient> {
  const loaded = await getPlugin(pluginId);
  if (!loaded) throw new Error(`Plugin "${pluginId}" not loaded`);
  const { plugin } = loaded;
  const credentials = await getLocalConnectionCredentials(
    accountId,
    plugin.manifest.credentialFields,
  );
  const services = buildPluginHostServices(plugin.manifest, credentials);
  return plugin.createClient(credentials, services);
}

/**
 * A client for a *peer* plugin reached through a parent resource: the
 * `kubernetes` plugin inside a managed cluster, `postgres` inside a managed
 * database. Credentials come from the parent's outputs, per the parent resource
 * type's `peerIntegrations`, and go through the credential rewriters as the
 * cloud's (server-core's `getClientForResource`) do, so a peer address that
 * names the account's SSH tunnel goes through it.
 */
export async function createPeerPluginClient(
  accountId: string,
  parentPluginId: string,
  parentResourceId: string,
  peerPluginId: string,
): Promise<HostPluginClient> {
  const parentLoaded = await getPlugin(parentPluginId);
  if (!parentLoaded) throw new Error(`Plugin "${parentPluginId}" not loaded`);
  const parentClient = await createPluginClient(accountId, parentPluginId);

  // Resource ids are `accountId:typeId:externalId`, so the parent's type is
  // usually right there. Fall back to whichever of the plugin's types declares
  // the peer, for ids that don't follow the convention.
  const idType = parentResourceId.split(":")[1];
  const typeDef =
    parentLoaded.plugin.resourceTypes.find(
      (t) => t.id === idType && t.peerIntegrations?.some((i) => i.pluginId === peerPluginId),
    ) ??
    parentLoaded.plugin.resourceTypes.find((t) =>
      t.peerIntegrations?.some((i) => i.pluginId === peerPluginId),
    );
  const integration = typeDef?.peerIntegrations?.find((i) => i.pluginId === peerPluginId);
  if (!typeDef || !integration) {
    throw new Error(`${parentPluginId} resources do not expose a ${peerPluginId} sidecar`);
  }

  const peerCredentials: Record<string, string> = {};
  for (const mapping of integration.credentialMappings) {
    peerCredentials[mapping.credentialKey] = await parentClient.resolveOutput(
      typeDef.id,
      parentResourceId,
      mapping.outputKey,
      accountId,
    );
  }

  const peerLoaded = await getPlugin(peerPluginId);
  if (!peerLoaded) throw new Error(`Plugin "${peerPluginId}" not loaded`);
  await applyCredentialRewriters(
    {
      accountId,
      credentialFields: peerLoaded.plugin.manifest.credentialFields,
      peerPluginId,
      resourcePluginId: parentPluginId,
      resourceTypeId: typeDef.id,
      resourceId: parentResourceId,
    },
    peerCredentials,
  );
  const services = buildPluginHostServices(peerLoaded.plugin.manifest, peerCredentials);
  return peerLoaded.plugin.createClient(peerCredentials, services);
}
