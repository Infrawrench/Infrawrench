/**
 * Peer (sidecar) plugin clients for the CLI — the plugin a resource exposes
 * rather than the one its account connects. A managed Kubernetes cluster
 * (DOKS, EKS, GKE, …) hands out a kubeconfig, so the `kubernetes` plugin can
 * be driven inside it; a managed database hands out a connection string, so
 * `postgres`/`mysql`/`redis`/`mongodb` can.
 *
 * Mirrors server-core's `peer-clients.ts`, minus what the CLI cannot (and
 * need not) do: credential rewriters are skipped. The rewriter chain is not
 * declared on the integration — it is a globally registered list (today only
 * the SSH-tunnel rewriter, a no-op unless the account has a server-side
 * tunnel configured), and the desktop renderer's own peer path skips it the
 * same way. The kubeconfig path this exists for needs none.
 *
 * The parent client may be either a local credential-backed client or an org
 * account's client — `resolveOutput` is the whole contract, and both
 * implement it.
 */
import type { PluginClient } from "@infrawrench/plugin-base" with { "resolution-mode": "import" };
import type { SidecarRef } from "@infrawrench/workflow-runtime" with {
  "resolution-mode": "import",
};

import { createPluginClientFromCredentials } from "../infrafile/plugin-host";
import { CliError } from "./context";

/**
 * One peer client per (parent resource, peer plugin) per process — the same
 * cluster reached twice in a deploy resolves its kubeconfig once. A failed
 * build is evicted so a retry (say, after the cluster finishes provisioning)
 * resolves fresh rather than replaying the cached rejection.
 */
const peerClients = new Map<string, Promise<PluginClient>>();

/**
 * The parent resource's type id, parsed from its canonical
 * `accountId:typeId:externalId` id. When the id is not in canonical form
 * (some listers return provider-native ids), fall back to the one resource
 * type on the parent plugin that declares a peer integration for this plugin
 * — typically exactly one (e.g. only gke-cluster carries a kubernetes peer).
 */
function resolveParentTypeId(
  parentResourceId: string,
  parentAccountId: string,
  parentPluginId: string,
  peerPluginId: string,
  resourceTypes: readonly { id: string; peerIntegrations?: { pluginId: string }[] }[],
): string {
  if (parentResourceId.startsWith(`${parentAccountId}:`)) {
    const typeId = parentResourceId.slice(parentAccountId.length + 1).split(":")[0];
    if (typeId && resourceTypes.some((t) => t.id === typeId)) return typeId;
  }
  const candidates = resourceTypes.filter((t) =>
    t.peerIntegrations?.some((i) => i.pluginId === peerPluginId),
  );
  if (candidates.length === 1) return candidates[0]!.id;
  throw new CliError(
    candidates.length === 0
      ? `No resource type of plugin "${parentPluginId}" declares a "${peerPluginId}" peer, ` +
          `so ${parentResourceId} cannot supply its credentials.`
      : `Cannot tell which "${parentPluginId}" resource type ${parentResourceId} is — ` +
          `${candidates.map((t) => t.id).join(", ")} all declare a "${peerPluginId}" peer.`,
    2,
  );
}

async function buildCliPeerClient(
  parentClient: PluginClient,
  parentAccountId: string,
  parentPluginId: string,
  sidecar: SidecarRef,
): Promise<PluginClient> {
  const { getPlugin } = await import("../infrafile/plugins.js");
  const parentLoaded = await getPlugin(parentPluginId);
  if (!parentLoaded) {
    throw new CliError(`Plugin "${parentPluginId}" is not available in this build.`, 2);
  }
  const peerLoaded = await getPlugin(sidecar.pluginId);
  if (!peerLoaded) {
    throw new CliError(
      `Peer plugin "${sidecar.pluginId}" is not available in this build, ` +
        `so ${sidecar.parentResourceId} cannot be reached through it.`,
      2,
    );
  }

  const parentTypeId = resolveParentTypeId(
    sidecar.parentResourceId,
    parentAccountId,
    parentPluginId,
    sidecar.pluginId,
    parentLoaded.plugin.resourceTypes,
  );
  const typeDef = parentLoaded.plugin.resourceTypes.find((t) => t.id === parentTypeId);
  const integration = typeDef?.peerIntegrations?.find((i) => i.pluginId === sidecar.pluginId);
  if (!integration) {
    throw new CliError(
      `${parentTypeId} declares no "${sidecar.pluginId}" peer integration — ` +
        `${sidecar.parentResourceId} cannot supply its credentials.`,
      2,
    );
  }

  // The credential mapping is declarative: each peer credential key names the
  // parent OUTPUT that carries its value (kubeconfig, connection string, …),
  // resolved live through the parent's client.
  const credentials: Record<string, string> = {};
  for (const mapping of integration.credentialMappings) {
    try {
      credentials[mapping.credentialKey] = await parentClient.resolveOutput(
        parentTypeId,
        sidecar.parentResourceId,
        mapping.outputKey,
        parentAccountId,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new CliError(
        `Could not resolve output "${mapping.outputKey}" of ${sidecar.parentResourceId} ` +
          `for the "${sidecar.pluginId}" peer: ${msg}`,
        2,
      );
    }
  }

  return createPluginClientFromCredentials(sidecar.pluginId, credentials);
}

/**
 * A ready-to-use client for the peer plugin a parent resource exposes: read
 * the parent type's `peerIntegrations` declaration from the local plugin
 * registry, resolve each mapped output through the parent's client, and build
 * the peer plugin's client (with its driver-backed host services — the
 * kubernetes plugin's manifest wires `k8sDrivers` off its kubeconfig
 * credential) from those credentials.
 */
export function createCliPeerClient(
  parentClient: PluginClient,
  parentAccountId: string,
  parentPluginId: string,
  sidecar: SidecarRef,
): Promise<PluginClient> {
  const key = `${sidecar.parentResourceId}:${sidecar.pluginId}`;
  let client = peerClients.get(key);
  if (!client) {
    client = buildCliPeerClient(parentClient, parentAccountId, parentPluginId, sidecar);
    client.catch(() => peerClients.delete(key));
    peerClients.set(key, client);
  }
  return client;
}
