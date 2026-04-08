import { requireAuth } from "@/auth/session";
import { db } from "@/db/client";
import { accounts, resources, secretFieldStates } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { getPlugin } from "@/plugins/loader";
import { decrypt } from "@/services/encryption";
import type { ResourceInstance, SecretFieldState, SecretResolution } from "@infrawrench/plugin-base";
import { notFound } from "next/navigation";
import { ResourceDetailClient } from "@/components/ResourceDetailClient";

interface Props {
  params: Promise<{ pluginId: string; resourceTypeId: string; resourceId: string }>;
}

export default async function ResourceDetailPage({ params }: Props) {
  const { organizationId } = await requireAuth();
  const { pluginId, resourceTypeId, resourceId: rawResourceId } = await params;
  const resourceId = decodeURIComponent(rawResourceId);

  const [resource] = await db
    .select()
    .from(resources)
    .where(
      and(
        eq(resources.id, resourceId),
        eq(resources.organizationId, organizationId),
        eq(resources.pluginId, pluginId),
        eq(resources.resourceTypeId, resourceTypeId),
        isNull(resources.deletedAt),
      ),
    )
    .limit(1);

  if (!resource) notFound();

  const secretStates = await db
    .select()
    .from(secretFieldStates)
    .where(eq(secretFieldStates.resourceId, resourceId));

  const instance: ResourceInstance = {
    id: resource.id,
    pluginId: resource.pluginId,
    resourceTypeId: resource.resourceTypeId,
    accountId: resource.accountId,
    displayName: resource.displayName,
    fields: (resource.fieldsJson as Record<string, string | number | boolean>) ?? {},
    resolvedOutputs: (resource.outputsJson as Record<string, string>) ?? {},
    secretStates: secretStates.map(
      (s): SecretFieldState => ({
        fieldKey: s.fieldKey,
        resolution:
          s.resolutionKind === "literal"
            ? {
                kind: "literal",
                encryptedValue: s.encryptedValue ?? "",
                iv: s.valueIv ?? "",
              }
            : ({
                kind: "output-ref",
                sourcePluginId: s.sourcePluginId ?? "",
                sourceResourceTypeId: s.sourceResourceTypeId ?? "",
                sourceResourceId: s.sourceResourceId ?? "",
                sourceAccountId: s.sourceAccountId ?? "",
                outputKey: s.sourceOutputKey ?? "",
                ...(s.cachedEncryptedValue != null && { cachedEncryptedValue: s.cachedEncryptedValue }),
                ...(s.cachedValueIv != null && { cachedIv: s.cachedValueIv }),
                ...(s.cachedAt != null && { cachedAt: s.cachedAt.toISOString() }),
              } satisfies SecretResolution),
      }),
    ),
    ...(resource.externalId != null && { externalId: resource.externalId }),
    ...(resource.parentResourceId != null && { parentResourceId: resource.parentResourceId }),
    createdAt: resource.createdAt.toISOString(),
    updatedAt: resource.updatedAt.toISOString(),
    ...(resource.lastSyncedAt != null && { lastSyncedAt: resource.lastSyncedAt.toISOString() }),
  };

  const loadedPlugin = await getPlugin(pluginId);
  if (!loadedPlugin) notFound();

  // Decrypt account credentials to create a proper plugin client
  const [account] = await db
    .select({
      encryptedCredentials: accounts.encryptedCredentials,
      credentialsIv: accounts.credentialsIv,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.id, resource.accountId),
        eq(accounts.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!account) notFound();

  const plaintext = await decrypt(account.encryptedCredentials, account.credentialsIv);
  const credentials = JSON.parse(plaintext) as Record<string, string>;
  const client = loadedPlugin.plugin.createClient(credentials);
  const detailSchema = client.renderDetail(instance);

  // Find child resources
  const childRows = await db
    .select()
    .from(resources)
    .where(
      and(
        eq(resources.parentResourceId, resourceId),
        eq(resources.organizationId, organizationId),
        isNull(resources.deletedAt),
      ),
    );

  const childResources = childRows.map((c) => ({
    id: c.id,
    displayName: c.displayName,
    resourceTypeId: c.resourceTypeId,
    pluginId: c.pluginId,
    accountId: c.accountId,
  }));

  return (
    <ResourceDetailClient
      detailSchema={detailSchema}
      childResources={childResources}
      pluginId={pluginId}
      pluginLogoSvg={loadedPlugin.plugin.manifest.logoSvg}
      resourceId={resourceId}
    />
  );
}
