import { eq, and, isNull } from "drizzle-orm";
import type {
  PeerPaneSchema,
  PeerPluginIntegration,
  Plugin,
  PluginClient,
  ResourceInstance,
} from "@infrawrench/plugin-base";
import { evaluatePeerIntegrationUnreachable } from "@infrawrench/plugin-base";
import { db } from "../db/client";
import { resources } from "../db/schema";
import { getPlugin } from "../plugins/loader";
import { buildPluginHostServices } from "./host-services";
import { applyCredentialRewriters } from "./credential-rewriters";
import { getOrgAccountClient } from "@infrawrench/server-core/org-accounts";

interface PeerPaneResult {
  tabLabel: string;
  pluginLogoSvg: string;
  schema: PeerPaneSchema;
  peerPluginId: string;
}

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
async function buildPeerPluginClient(input: {
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
