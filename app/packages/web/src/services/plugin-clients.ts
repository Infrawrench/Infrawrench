import type { PeerPaneSchema, PeerPluginIntegration, Plugin } from "@infrawrench/plugin-base";
import { evaluatePeerIntegrationUnreachable } from "@infrawrench/plugin-base";
import type { PluginClient } from "@infrawrench/plugin-base";
import { getPlugin } from "../plugins/loader";
import { buildPeerPluginClient } from "@infrawrench/server-core/peer-clients";
import { getOrgAccountClient } from "@infrawrench/server-core/org-accounts";

// Peer-client resolution itself lives in server-core: the workflow runner needs
// it too, and that is shared with the poller (which can't import from web).
export {
  filterVisiblePeerIntegrations,
  getClientForResource,
} from "@infrawrench/server-core/peer-clients";

interface PeerPaneResult {
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
        const built = await buildPeerPluginClient({
          parentClient,
          parentPluginId: parentPlugin.manifest.id,
          parentResourceTypeId: resourceTypeId,
          parentResourceId: resourceId,
          parentResource,
          integration,
          accountId,
          ...(organizationId !== undefined && { organizationId }),
        });
        if (!built) return;
        const { client: peerClient, plugin: peerPlugin } = built;
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
          pluginLogoSvg: peerPlugin.manifest.logoSvg,
          schema: { ...peerSchema, supportsYamlImport: !!peerClient.importYaml },
          peerPluginId: integration.pluginId,
        });
      } catch (err) {
        const peerLoaded = await getPlugin(integration.pluginId);
        if (!peerLoaded) return;
        const message = err instanceof Error ? err.message : String(err);
        // When the integration declares a credential-setup CTA (e.g. "Make
        // connection user"), surface it as guidance + a button instead of a
        // bare error, so the fix is one click away inside the pane.
        if (integration.credentialSetupAction) {
          panes.push({
            tabLabel: integration.tabLabel,
            pluginLogoSvg: peerLoaded.plugin.manifest.logoSvg,
            schema: {
              resourceGroups: [],
              guidance: {
                title: message,
                suggestions: [],
                action: integration.credentialSetupAction,
              },
            },
            peerPluginId: integration.pluginId,
          });
          return;
        }
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

/** Decrypt an account's credentials and instantiate its plugin client. */
export const getClientForAccount = getOrgAccountClient;
