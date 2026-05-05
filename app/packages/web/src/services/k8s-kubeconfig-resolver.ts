/**
 * Resolves the kubeconfig string for a Kubernetes peer integration.
 * Used by the K8s exec WebSocket handler to spawn kubectl exec
 * without sending the kubeconfig to the browser.
 */
import { eq, and, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, resources } from "@/db/schema";
import { decrypt } from "@/services/encryption";
import { getPlugin } from "@/plugins/loader";
import { buildPluginHostServices } from "@/services/host-services";

/**
 * Given a parent resource and peer plugin ID, resolve the kubeconfig
 * that would be passed to the peer plugin client.
 */
export async function resolveKubeconfig(
  organizationId: string,
  accountId: string,
  resourceId: string,
  peerPluginId: string,
): Promise<string | null> {
  // Load the parent account + plugin
  const [account] = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.id, accountId),
        eq(accounts.organizationId, organizationId),
        isNull(accounts.deletedAt),
      ),
    )
    .limit(1);
  if (!account) return null;

  const loaded = await getPlugin(account.pluginId);
  if (!loaded) return null;

  const plaintext = await decrypt(account.encryptedCredentials, account.credentialsIv);
  const credentials = JSON.parse(plaintext) as Record<string, string>;
  const hostServices = buildPluginHostServices(loaded.plugin.manifest, credentials);
  const client = loaded.plugin.createClient(credentials, hostServices);

  // Find the resource to get its resourceTypeId
  const [resource] = await db
    .select({ resourceTypeId: resources.resourceTypeId })
    .from(resources)
    .where(
      and(
        eq(resources.id, resourceId),
        eq(resources.organizationId, organizationId),
        isNull(resources.deletedAt),
      ),
    )
    .limit(1);
  if (!resource) return null;

  const resourceTypeDef = loaded.plugin.resourceTypes.find((t) => t.id === resource.resourceTypeId);
  if (!resourceTypeDef?.peerIntegrations?.length) return null;

  // Find the peer integration for the requested plugin
  const integration = resourceTypeDef.peerIntegrations.find((i) => i.pluginId === peerPluginId);
  if (!integration) return null;

  // Resolve credentials (one of which should be "kubeconfig")
  const peerCredentials: Record<string, string> = {};
  for (const mapping of integration.credentialMappings) {
    try {
      const value = await client.resolveOutput(
        resource.resourceTypeId,
        resourceId,
        mapping.outputKey,
        accountId,
      );
      peerCredentials[mapping.credentialKey] = value;
    } catch {
      // Skip unresolvable outputs
    }
  }

  return peerCredentials["kubeconfig"] ?? null;
}
