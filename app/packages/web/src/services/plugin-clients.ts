import { eq, and, isNull } from "drizzle-orm";
import type {
  PeerPaneSchema,
  PeerPluginIntegration,
  Plugin,
  PluginClient,
} from "@infrawrench/plugin-base";
import { evaluatePeerIntegrationUnreachable } from "@infrawrench/plugin-base";
import { db } from "../db/client";
import { accounts, resources } from "../db/schema";
import { decrypt, buildAad } from "./encryption";
import { getPlugin } from "../plugins/loader";
import { buildPluginHostServices } from "./host-services";
import { applyCredentialRewriters } from "./credential-rewriters";

export interface PeerPaneResult {
  tabLabel: string;
  pluginLogoSvg: string;
  schema: PeerPaneSchema;
  peerPluginId: string;
}

/**
 * For each peer integration, resolve peer credentials via the parent client's
 * outputs, build the peer plugin's client, and call `renderPeerPane`. Errors
 * for individual integrations are captured as error-status panes — one bad
 * peer never poisons the others. Used by both the eager (GET /detail) and
 * lazy (POST /peer-panes) endpoints.
 */
export async function buildPeerPanes(
  parentClient: PluginClient,
  parentPlugin: Plugin,
  integrations: PeerPluginIntegration[],
  resourceTypeId: string,
  resourceId: string,
  accountId: string,
  organizationId?: string,
): Promise<PeerPaneResult[]> {
  const panes: PeerPaneResult[] = [];
  // Fetch the parent ResourceInstance once so credential rewriters that need
  // resource-level data (e.g. Cloud SQL Auth Proxy needs `connectionName`)
  // can read it from `ctx.resourceFields` / `ctx.resourceOutputs` instead of
  // re-querying storage.
  const parentResource = await parentClient
    .getResource(resourceTypeId, resourceId, accountId)
    .catch(() => null);
  await Promise.allSettled(
    integrations.map(async (integration) => {
      // Provider-declared unreachable check (e.g. private-IP-only Cloud SQL).
      // Short-circuit before we resolve outputs, run rewriters, or load the
      // peer plugin — just hand back the guidance pane.
      const guidance = evaluatePeerIntegrationUnreachable(integration, parentResource?.fields);
      if (guidance) {
        const peerLoaded = await getPlugin(integration.pluginId);
        if (!peerLoaded) return;
        panes.push({
          tabLabel: integration.tabLabel,
          pluginLogoSvg: peerLoaded.plugin.manifest.logoSvg,
          schema: { resourceGroups: [], guidance },
          peerPluginId: integration.pluginId,
        });
        return;
      }
      try {
        const peerCredentials: Record<string, string> = {};
        for (const mapping of integration.credentialMappings) {
          const value = await parentClient.resolveOutput(
            resourceTypeId,
            resourceId,
            mapping.outputKey,
            accountId,
          );
          peerCredentials[mapping.credentialKey] = value;
        }

        await applyCredentialRewriters(
          {
            orgId: organizationId,
            accountId,
            resourcePluginId: parentPlugin.manifest.id,
            resourceTypeId,
            resourceId,
            resourceFields: parentResource?.fields,
            resourceOutputs: parentResource?.resolvedOutputs,
          },
          peerCredentials,
        );

        const peerLoaded = await getPlugin(integration.pluginId);
        if (!peerLoaded) return;

        const peerHostServices = buildPluginHostServices(
          peerLoaded.plugin.manifest,
          peerCredentials,
        );
        const peerClient = peerLoaded.plugin.createClient(peerCredentials, peerHostServices);
        if (!peerClient.renderPeerPane) return;

        const context = {
          tabLabel: integration.tabLabel,
          parentPluginId: parentPlugin.manifest.id,
          parentResourceTypeId: resourceTypeId,
          parentResourceId: resourceId,
          accountId,
        };
        const peerSchema = await peerClient.renderPeerPane(context);

        panes.push({
          tabLabel: integration.tabLabel,
          pluginLogoSvg: peerLoaded.plugin.manifest.logoSvg,
          schema: { ...peerSchema, supportsYamlImport: !!peerClient.importYaml },
          peerPluginId: integration.pluginId,
        });
      } catch (err) {
        const peerLoaded = await getPlugin(integration.pluginId);
        if (!peerLoaded) return;
        const message = err instanceof Error ? err.message : String(err);
        panes.push({
          tabLabel: integration.tabLabel,
          pluginLogoSvg: peerLoaded.plugin.manifest.logoSvg,
          schema: {
            status: { kind: "status-dot", status: "error", label: message },
            resourceGroups: [],
          },
          peerPluginId: integration.pluginId,
        });
      }
    }),
  );
  return panes;
}

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

  const plaintext = await decrypt(
    account.encryptedCredentials,
    account.credentialsIv,
    buildAad("account", account.id, "credentials"),
  );
  const credentials = JSON.parse(plaintext) as Record<string, string>;

  await applyCredentialRewriters({ orgId: organizationId, accountId }, credentials);

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

  // Fetch the parent ResourceInstance so the rewriter context carries live
  // fields/outputs (Cloud SQL Auth Proxy needs `connectionName`).
  const parentInstance = await parent.client
    .getResource(parentResource.resourceTypeId, parentResourceId, accountId)
    .catch(() => null);

  await applyCredentialRewriters(
    {
      orgId: organizationId,
      accountId,
      resourcePluginId: parent.account.pluginId,
      resourceTypeId: parentResource.resourceTypeId,
      resourceId: parentResourceId,
      resourceFields: parentInstance?.fields,
      resourceOutputs: parentInstance?.resolvedOutputs,
    },
    peerCredentials,
  );

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
