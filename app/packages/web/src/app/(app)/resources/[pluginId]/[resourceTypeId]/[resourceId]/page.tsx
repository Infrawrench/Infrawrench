import { requireAuth } from "@/auth/session";
import { db } from "@/db/client";
import { resources, secretFieldStates } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getPlugin } from "@/plugins/loader";
import type { ResourceInstance, SecretFieldState, SecretResolution } from "@infrawrench/plugin-base";
import { notFound } from "next/navigation";

interface Props {
  params: { pluginId: string; resourceTypeId: string; resourceId: string };
}

export default async function ResourceDetailPage({ params }: Props) {
  const { organizationId } = await requireAuth();
  const { pluginId, resourceTypeId, resourceId } = params;

  const [resource] = await db
    .select()
    .from(resources)
    .where(
      and(
        eq(resources.id, resourceId),
        eq(resources.organizationId, organizationId),
        eq(resources.pluginId, pluginId),
        eq(resources.resourceTypeId, resourceTypeId),
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
                cachedEncryptedValue: s.cachedEncryptedValue ?? undefined,
                cachedIv: s.cachedValueIv ?? undefined,
                cachedAt: s.cachedAt?.toISOString(),
              } satisfies SecretResolution),
      }),
    ),
    externalId: resource.externalId ?? undefined,
    parentResourceId: resource.parentResourceId ?? undefined,
    createdAt: resource.createdAt.toISOString(),
    updatedAt: resource.updatedAt.toISOString(),
    lastSyncedAt: resource.lastSyncedAt?.toISOString(),
  };

  const loadedPlugin = await getPlugin(pluginId);
  if (!loadedPlugin) notFound();

  // Plugin renders the schema — no React, just data
  const detailSchema = loadedPlugin.plugin.createClient({}).renderDetail(instance);

  return (
    <div className="p-6">
      <div id="detail-view-root" data-schema={JSON.stringify(detailSchema)} />
    </div>
  );
}
