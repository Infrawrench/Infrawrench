import { invoke } from "./invoke";
import { getPlugin } from "../plugins/loader";
import { buildPluginHostServices } from "./sql-drivers";
import type { PluginClient } from "@infrawrench/plugin-base";

export async function createPluginClient(
  accountId: string,
  pluginId: string,
): Promise<PluginClient> {
  const credentials = await invoke<Record<string, string>>("account_get_credentials", {
    accountId,
  });
  const loaded = await getPlugin(pluginId);
  if (!loaded) throw new Error(`Plugin "${pluginId}" not loaded`);
  const { plugin } = loaded;
  const services = buildPluginHostServices(plugin.manifest, credentials);
  return plugin.createClient(credentials, services);
}

/**
 * A client for a *peer* plugin reached through a parent resource — the
 * `kubernetes` plugin inside a managed cluster, `postgres` inside a managed
 * database. Credentials come from the parent's outputs, per the parent resource
 * type's `peerIntegrations`.
 *
 * The cloud equivalent (server-core's `getClientForResource`) additionally runs
 * the credential rewriters; desktop has none to run, since the rewriters exist
 * to put a proxy in front of cloud-only network paths.
 */
export async function createPeerPluginClient(
  accountId: string,
  parentPluginId: string,
  parentResourceId: string,
  peerPluginId: string,
): Promise<PluginClient> {
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
  const services = buildPluginHostServices(peerLoaded.plugin.manifest, peerCredentials);
  return peerLoaded.plugin.createClient(peerCredentials, services);
}
