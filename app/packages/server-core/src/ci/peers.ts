/**
 * A resource used by CI as its peer: a managed cluster as a `kubernetes`
 * connection, a managed database as a `postgres` one. Only a peer
 * integration that declares what it lends CI (`PeerPluginIntegration.ci`) is
 * offered; the declaration is what the grant form shows, and it can name the
 * outputs CI reads instead of the peer tabs' (a token minted per run) and a
 * field the resource must have for it to be lent at all.
 *
 * The peer client is built the way the peer tabs build it
 * (`buildPeerPluginClient`: output mappings, then the credential rewriters),
 * with two refusals of CI's own: credentials the SSH-tunnel rewriter changed
 * (it points the address at the tunnel's local end on the gateway, which a job
 * cannot reach, while keeping the real password or token), and a resource
 * whose declaration's `availableWhen` does not hold.
 */
import { eq } from "drizzle-orm";
import type {
  HostPlugin,
  HostPluginClient,
  PeerCiDeclaration,
  PeerPluginIntegration,
} from "@infrawrench/plugin-base";
import type { CiPeerOption } from "@infrawrench/client-core";

import { db } from "../db/client.js";
import { sshTunnelConfigs } from "../db/schema.js";
import { getOrgAccountClient } from "../org-accounts.js";
import { buildPeerPluginClient, filterVisiblePeerIntegrations } from "../peer-clients.js";

/** What a plugin can run for CI, as the wire carries it. */
export function executorInfoOf(plugin: HostPlugin): CiPeerOption["executor"] {
  const { ciExecutor } = plugin.manifest;
  return ciExecutor
    ? {
        kinds: ciExecutor.kinds.map((k) => ({
          kind: k.kind,
          label: k.label,
          defaults: { ...k.defaults },
          ...(k.typicalStartSeconds !== undefined
            ? { typicalStartSeconds: k.typicalStartSeconds }
            : {}),
          ...(k.minimumBillingSeconds !== undefined
            ? { minimumBillingSeconds: k.minimumBillingSeconds }
            : {}),
          ...(k.gpus ? { gpus: true } : {}),
          ...(k.machineSuggestions ? { machineSuggestions: [...k.machineSuggestions] } : {}),
          ...(k.regionLabel ? { regionLabel: k.regionLabel } : {}),
        })),
        helpLink: ciExecutor.helpLink ? { ...ciExecutor.helpLink } : null,
      }
    : null;
}

/** What a plugin lends a job, as the wire carries it. */
export function credentialInfoOf(plugin: HostPlugin): CiPeerOption["credential"] {
  const { ciCredential } = plugin.manifest;
  return ciCredential
    ? {
        description: ciCredential.description,
        shortLived: ciCredential.shortLived,
        namespaces: ciCredential.namespaces === true,
      }
    : null;
}

/** Why a resource cannot be used as this peer, or null when it can. */
export function peerUnavailable(
  declaration: PeerCiDeclaration,
  fields: Record<string, unknown> | null | undefined,
): string | null {
  const gate = declaration.availableWhen;
  if (!gate) return null;
  const value = (fields ?? {})[gate.fieldKey];
  return value != null && String(value) === gate.equals ? null : gate.reason;
}

/** Whether every field a peer integration names as its way in is empty. */
function unreachableOf(
  integration: PeerPluginIntegration,
  fields: Record<string, unknown>,
): string | null {
  const gate = integration.unreachableWhen;
  if (!gate) return null;
  const empty = gate.fieldsEmpty.every((k) => fields[k] == null || fields[k] === "");
  return empty ? gate.title : null;
}

/**
 * What a resource can be used as by CI: the peer integrations its type
 * declares that apply to it (the same gates the peer tabs use) and that say
 * what they lend CI, whose plugin lends a connection to jobs or runs cloud
 * jobs.
 */
export function peerOptionsOf(
  resource: { pluginId: string; resourceTypeId: string; fields: Record<string, unknown> | null },
  plugins: Map<string, HostPlugin>,
): CiPeerOption[] {
  const type = plugins
    .get(resource.pluginId)
    ?.resourceTypes.find((t) => t.id === resource.resourceTypeId);
  const fields = resource.fields ?? {};
  const out: CiPeerOption[] = [];
  for (const integration of filterVisiblePeerIntegrations(type?.peerIntegrations ?? [], fields)) {
    const declaration = integration.ci;
    const peer = plugins.get(integration.pluginId);
    if (!declaration || !peer || out.some((o) => o.pluginId === integration.pluginId)) continue;
    const credential = credentialInfoOf(peer);
    const executor = executorInfoOf(peer);
    if (!credential && !executor) continue;
    out.push({
      pluginId: integration.pluginId,
      pluginName: peer.manifest.displayName,
      credential,
      executor,
      lends: declaration.lends,
      reach: declaration.reach,
      lifetime: declaration.lifetime,
      unavailable: peerUnavailable(declaration, fields),
      unreachable: unreachableOf(integration, fields),
    });
  }
  return out;
}

/** Infrawrench reaches the connection through an SSH tunnel of its own. */
export async function reachedThroughTunnel(accountId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: sshTunnelConfigs.id })
    .from(sshTunnelConfigs)
    .where(eq(sshTunnelConfigs.accountId, accountId))
    .limit(1);
  return row !== undefined;
}

/** What `ciPeerClient` is asked for: what may refuse depends on it. */
export type PeerUse = "lend" | "run" | "teardown";

export type CiPeerClient =
  | {
      client: HostPluginClient;
      plugin: HostPlugin;
      credentials: Record<string, string>;
    }
  | { refused: string };

/**
 * The peer client CI uses for a resource: credentials from the CI
 * declaration's outputs (falling back to the integration's), through the
 * rewriters, as the peer tabs build theirs. Null when the account or the
 * peer is gone; a refusal when CI may not use it. Teardown refuses nothing it
 * can avoid refusing: compute already started has to be removed.
 */
export async function ciPeerClient(
  organizationId: string,
  resource: { id: string; accountId: string; resourceTypeId: string },
  peerPluginId: string,
  use: PeerUse,
): Promise<CiPeerClient | null> {
  const parent = await getOrgAccountClient(resource.accountId, organizationId);
  if (!parent) return null;
  // The account's own plugin is not a peer of its resources.
  if (parent.account.pluginId === peerPluginId) return null;
  const type = parent.plugin.resourceTypes.find((t) => t.id === resource.resourceTypeId);
  const integration = type?.peerIntegrations?.find(
    (i) => i.pluginId === peerPluginId && i.ci !== undefined,
  );
  const declaration = integration?.ci;
  if (!integration || !declaration) {
    return { refused: `it is no longer offered to CI as \`${peerPluginId}\`` };
  }
  const instance = await parent.client
    .getResource(resource.resourceTypeId, resource.id, resource.accountId)
    .catch(() => null);
  if (use !== "teardown") {
    if (!instance) return { refused: "its provider no longer lists it" };
    const unavailable = peerUnavailable(declaration, instance.fields);
    if (unavailable) return { refused: unavailable };
  }
  const overrides = declaration.credentialMappings ?? [];
  const credentialMappings = [
    ...integration.credentialMappings.filter(
      (m) => !overrides.some((o) => o.credentialKey === m.credentialKey),
    ),
    ...overrides,
  ];
  const built = await buildPeerPluginClient({
    parentClient: parent.client,
    parentPluginId: parent.account.pluginId,
    parentResourceTypeId: resource.resourceTypeId,
    parentResourceId: resource.id,
    parentResource: instance,
    integration: { ...integration, credentialMappings },
    accountId: resource.accountId,
    organizationId,
  });
  if (built && use !== "teardown") {
    const tunnelled = await tunnelRefusal(resource.accountId, built.rewritten);
    if (tunnelled) return { refused: tunnelled };
  }
  return built;
}

/**
 * Why credentials resolved for a connection cannot be lent: a credential
 * rewriter changed them (`rewritten`, from `applyCredentialRewriters`), which
 * the SSH-tunnel rewriter does to the addresses it points at the tunnel's
 * local end on the gateway. A job reaches neither that nor, usually, the
 * private address behind it, so nothing is lent: not the rewritten value, and
 * not the original either. A credential the rewriter left alone (a peer whose
 * address is not the tunnel's remote end) is lent as usual. Null when they can be.
 */
export async function tunnelRefusal(
  accountId: string,
  rewritten: boolean | undefined,
): Promise<string | null> {
  if (!rewritten) return null;
  return (await reachedThroughTunnel(accountId))
    ? "Infrawrench reaches its connection through an SSH tunnel of its own, which a job cannot use; lend it to jobs that can reach it directly, or connect it without the tunnel"
    : "Infrawrench reaches its connection through a local endpoint of its own, which a job cannot use";
}
