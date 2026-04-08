"use server";

import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts } from "@/db/schema";
import { decrypt } from "@/services/encryption";
import { requireAuth } from "@/auth/session";
import { getPlugin } from "@/plugins/loader";
import { buildPluginHostServices } from "@/services/host-services";

/**
 * Helper: get an authenticated plugin client for a given account.
 */
async function getClientForAccount(accountId: string) {
  const { organizationId } = await requireAuth();

  const [account] = await db
    .select({
      id: accounts.id,
      pluginId: accounts.pluginId,
      encryptedCredentials: accounts.encryptedCredentials,
      credentialsIv: accounts.credentialsIv,
    })
    .from(accounts)
    .where(
      and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)),
    )
    .limit(1);

  if (!account) throw new Error("Account not found");

  const plaintext = await decrypt(account.encryptedCredentials, account.credentialsIv);
  const credentials = JSON.parse(plaintext) as Record<string, string>;

  const loaded = await getPlugin(account.pluginId);
  if (!loaded) throw new Error(`Plugin "${account.pluginId}" not loaded`);

  const hostServices = buildPluginHostServices(loaded.plugin.manifest, credentials);
  const client = loaded.plugin.createClient(credentials, hostServices);
  return { client, plugin: loaded.plugin, credentials, account };
}

// ── Manifest editor ──────────────────────────────────────────────────────────

export async function getManifest(input: {
  accountId: string;
  resourceId: string;
}): Promise<string> {
  const { client } = await getClientForAccount(input.accountId);
  if (!client.getManifest) throw new Error("Plugin does not support manifest viewing");
  return client.getManifest(input.resourceId, input.accountId);
}

export async function applyManifest(input: {
  accountId: string;
  resourceId: string;
  manifest: string;
}): Promise<void> {
  const { client } = await getClientForAccount(input.accountId);
  if (!client.applyManifest) throw new Error("Plugin does not support manifest editing");
  await client.applyManifest(input.resourceId, input.accountId, input.manifest);
}

// ── Resource deletion ────────────────────────────────────────────────────────

export async function deleteResource(input: {
  accountId: string;
  resourceTypeId: string;
  resourceId: string;
}): Promise<void> {
  const { client } = await getClientForAccount(input.accountId);
  if (!client.deleteResource) throw new Error("Plugin does not support deletion");
  await client.deleteResource(input.resourceTypeId, input.resourceId, input.accountId);
}

// ── Resource creation ────────────────────────────────────────────────────────

export async function createResource(input: {
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  fields: Record<string, string>;
}): Promise<{ id: string; displayName: string }> {
  const { client } = await getClientForAccount(input.accountId);
  if (!client.createResource) throw new Error("Plugin does not support creation");
  const created = await client.createResource(
    input.resourceTypeId,
    input.accountId,
    input.fields,
  );
  return { id: created.id, displayName: created.displayName };
}

// ── Peer pane rendering ──────────────────────────────────────────────────────

export async function resolvePeerPanes(input: {
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  resourceId: string;
}): Promise<
  Array<{
    tabLabel: string;
    pluginLogoSvg: string;
    schema: unknown;
  }>
> {
  const { client, plugin } = await getClientForAccount(input.accountId);

  const resourceTypeDef = plugin.resourceTypes.find(
    (t) => t.id === input.resourceTypeId,
  );
  if (!resourceTypeDef?.peerIntegrations?.length) return [];

  const panes: Array<{
    tabLabel: string;
    pluginLogoSvg: string;
    schema: unknown;
  }> = [];

  await Promise.allSettled(
    resourceTypeDef.peerIntegrations.map(async (integration) => {
      try {
        const peerCredentials: Record<string, string> = {};
        for (const mapping of integration.credentialMappings) {
          const value = await client.resolveOutput(
            input.resourceTypeId,
            input.resourceId,
            mapping.outputKey,
            input.accountId,
          );
          peerCredentials[mapping.credentialKey] = value;
        }

        const peerLoaded = await getPlugin(integration.pluginId);
        if (!peerLoaded) return;

        const peerClient = peerLoaded.plugin.createClient(peerCredentials);
        if (!peerClient.renderPeerPane) return;

        const context = {
          tabLabel: integration.tabLabel,
          parentPluginId: plugin.manifest.id,
          parentResourceTypeId: input.resourceTypeId,
          parentResourceId: input.resourceId,
        };
        const peerSchema = await peerClient.renderPeerPane(context);

        panes.push({
          tabLabel: integration.tabLabel,
          pluginLogoSvg: peerLoaded.plugin.manifest.logoSvg,
          schema: peerSchema,
        });
      } catch {
        // Peer failed (e.g. cluster provisioning) — show provisioning placeholder
        const peerLoaded = await getPlugin(integration.pluginId);
        if (!peerLoaded) return;
        panes.push({
          tabLabel: integration.tabLabel,
          pluginLogoSvg: peerLoaded.plugin.manifest.logoSvg,
          schema: {
            status: { kind: "status-dot", status: "provisioning", label: "Provisioning" },
            resourceGroups: [],
          },
        });
      }
    }),
  );

  return panes;
}
