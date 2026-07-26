/**
 * Resolving a *peer* plugin's client — the plugin a resource exposes rather
 * than the one its account connects. A managed Kubernetes cluster hands out a
 * kubeconfig, so the `kubernetes` plugin can be driven inside it; a managed
 * database hands out a connection string, so `postgres`/`mysql`/`redis`/
 * `mongodb` can. Credentials are resolved from the parent resource's outputs,
 * run through the credential rewriters (Cloud SQL Auth Proxy and friends), and
 * handed to the peer plugin's own client.
 *
 * This lives in server-core rather than the web package because all three cloud
 * consumers need it: the HTTP routes and MCP tools (peer panes, `list_resources`
 * with a `parentResourceId`), and the workflow runner, which is shared with the
 * poller and cannot import from web.
 */
import { eq, and, isNull } from "drizzle-orm";
import type {
  PeerPluginIntegration,
  Plugin,
  PluginClient,
  ResourceInstance,
} from "@infrawrench/plugin-base";

import { db } from "./db/client";
import { resources } from "./db/schema";
import { getPlugin } from "./plugin-loader";
import { buildPluginHostServices } from "./host-services";
import { applyCredentialRewriters } from "./credential-rewriters";
import { getOrgAccountClient } from "./org-accounts";

/**
 * Apply the declarative `requiresFields` / `showWhen` gates from each peer
 * integration against a parent resource's fields. Used by both the eager
 * (GET /detail) and lazy (POST /peer-panes) endpoints so they agree on
 * which peer tabs should appear.
 */
export function filterVisiblePeerIntegrations(
  integrations: PeerPluginIntegration[],
  fields: Record<string, unknown> | undefined,
): PeerPluginIntegration[] {
  const f = fields ?? {};
  return integrations.filter((i) => {
    if (i.requiresFields) {
      for (const key of i.requiresFields) {
        const v = f[key];
        if (v == null || v === "") return false;
      }
    }
    if (!i.showWhen) return true;
    const v = f[i.showWhen.fieldKey];
    if (v == null || v === "") return false;
    const s = String(v);
    if (i.showWhen.equals != null) return s === i.showWhen.equals;
    if (i.showWhen.prefix != null) return s.startsWith(i.showWhen.prefix);
    return Boolean(v);
  });
}

/**
 * Resolve peer credentials via the parent client's outputs, run any matching
 * credential rewriters, and instantiate the peer plugin's client. Returns
 * `null` if the peer plugin isn't registered. Shared by `buildPeerPanes`
 * (eager rendering) and `getClientForResource` (HTTP route dispatch).
 */
export async function buildPeerPluginClient(input: {
  parentClient: PluginClient;
  parentPluginId: string;
  parentResourceTypeId: string;
  parentResourceId: string;
  parentResource: ResourceInstance | null;
  integration: PeerPluginIntegration;
  accountId: string;
  organizationId?: string;
}): Promise<{ client: PluginClient; plugin: Plugin; credentials: Record<string, string> } | null> {
  const peerCredentials: Record<string, string> = {};
  for (const mapping of input.integration.credentialMappings) {
    const value = await input.parentClient.resolveOutput(
      input.parentResourceTypeId,
      input.parentResourceId,
      mapping.outputKey,
      input.accountId,
    );
    peerCredentials[mapping.credentialKey] = value;
  }

  await applyCredentialRewriters(
    {
      ...(input.organizationId !== undefined && { orgId: input.organizationId }),
      accountId: input.accountId,
      resourcePluginId: input.parentPluginId,
      resourceTypeId: input.parentResourceTypeId,
      resourceId: input.parentResourceId,
      ...(input.parentResource?.fields !== undefined && {
        resourceFields: input.parentResource.fields,
      }),
      ...(input.parentResource?.resolvedOutputs !== undefined && {
        resourceOutputs: input.parentResource.resolvedOutputs,
      }),
    },
    peerCredentials,
  );

  const peerLoaded = await getPlugin(input.integration.pluginId);
  if (!peerLoaded) return null;

  const peerHostServices = await buildPluginHostServices(
    peerLoaded.plugin.manifest,
    peerCredentials,
    { accountId: input.accountId },
  );
  const peerClient = peerLoaded.plugin.createClient(peerCredentials, peerHostServices);
  return { client: peerClient, plugin: peerLoaded.plugin, credentials: peerCredentials };
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
  const parent = await getOrgAccountClient(accountId, organizationId);
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

  let parentResourceTypeId: string | undefined = parentResource?.resourceTypeId;
  let integration: PeerPluginIntegration | undefined;
  // Fetch the parent ResourceInstance so the rewriter context carries live
  // fields/outputs (Cloud SQL Auth Proxy needs `connectionName`).
  let parentInstance: ResourceInstance | null = null;

  if (parentResourceTypeId) {
    const parentResourceTypeDef = parent.plugin.resourceTypes.find(
      (t) => t.id === parentResourceTypeId,
    );
    integration = parentResourceTypeDef?.peerIntegrations?.find((i) => i.pluginId === pluginId);
    if (!integration) return null;
    parentInstance = await parent.client
      .getResource(parentResourceTypeId, parentResourceId, accountId)
      .catch(() => null);
  } else {
    // The parent resource isn't synced into the resources table (live-listed
    // only — common for discovered managed clusters/databases). Resolve its
    // type by probing the parent plugin's resource types that declare a peer
    // integration for the requested plugin; typically that's exactly one type
    // (e.g. only doks-cluster carries a kubernetes peer).
    for (const typeDef of parent.plugin.resourceTypes) {
      const candidate = typeDef.peerIntegrations?.find((i) => i.pluginId === pluginId);
      if (!candidate) continue;
      const inst = await parent.client
        .getResource(typeDef.id, parentResourceId, accountId)
        .catch(() => null);
      if (inst) {
        parentResourceTypeId = typeDef.id;
        integration = candidate;
        parentInstance = inst;
        break;
      }
    }
    if (!integration || !parentResourceTypeId) return null;
  }

  const built = await buildPeerPluginClient({
    parentClient: parent.client,
    parentPluginId: parent.account.pluginId,
    parentResourceTypeId,
    parentResourceId,
    parentResource: parentInstance,
    integration,
    accountId,
    organizationId,
  });
  if (!built) return null;
  return { ...built, account: parent.account };
}
